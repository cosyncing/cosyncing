import 'dart:convert';

import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_store.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_source_migration.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_route_context.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_routes.dart';
import 'package:cosyncing_client/src/features/pairing/data/transport_pairing_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart';

/// Explicit same-principal merge, admitted by the global profile mutation gate
/// after both live generations and mounted draft writers have been fenced.
final class BrokerProfileMerge {
  /// Shares the stores needed to preserve both reviewed access profiles.
  BrokerProfileMerge(
    this.database,
    this.routes,
    this.credentials,
    this.pairings,
  );

  /// App database containing route metadata and source-owned local state.
  final AppDatabase database;

  /// Versioned route store shared with profile migration and proxy editors.
  final BrokerRouteStore routes;

  /// Broker authentication material; attached only after identity verification.
  final CredentialStore credentials;

  /// Existing secure pairing material; merges preserve its ownership boundary.
  final TransportPairingStore pairings;

  /// Reads a bounded recovery page without exposing stored JSON to the UI.
  Future<List<({int rowId, Map<String, dynamic> payload})>> recoveredDrafts({
    required String source,
    required int cursor,
    required bool previous,
  }) async {
    final rows = await database
        .customSelect(
          'SELECT rowid,payload FROM broker_recovered_drafts WHERE source=? '
          'AND rowid${previous ? '<' : '>'}? ORDER BY rowid '
          '${previous ? 'DESC' : 'ASC'} LIMIT 101',
          variables: [Variable(source), Variable(cursor)],
        )
        .get();
    return [
      for (final row in rows)
        (
          rowId: row.read<int>('rowid'),
          payload:
              jsonDecode(row.read<String>('payload')) as Map<String, dynamic>,
        ),
    ];
  }

  /// Secret cleanup remains journaled after the atomic ownership move. Restart
  /// can finish it without repeating any draft or outbox mutation.
  Future<void> recover() async {
    final pending = await database
        .customSelect(
          "SELECT * FROM broker_profile_merges WHERE state='cleanup'",
        )
        .get();
    for (final row in pending) {
      final credential = row.readNullable<String>('credential_ref');
      if (credential != null) {
        final used = await database
            .customSelect(
              'SELECT 1 FROM broker_profile_rows WHERE credential_key=? LIMIT '
              '1',
              variables: [Variable(credential)],
            )
            .getSingleOrNull();
        if (used == null) await credentials.deleteBrokerToken(credential);
      }
      final pairing = row.readNullable<String>('pairing_ref');
      if (pairing != null) {
        final records = await database
            .customSelect('SELECT payload FROM broker_route_servers')
            .get();
        final used = records.any(
          (r) =>
              (jsonDecode(r.read<String>('payload'))
                  as Map)['pairingReference'] ==
              pairing,
        );
        if (!used) await pairings.delete(pairing);
      }
      await database.customStatement(
        "UPDATE broker_profile_merges SET state='complete' WHERE id=?",
        [row.read<String>('id')],
      );
    }
  }

  /// Merges verified equal-principal profiles with explicit route choices.
  Future<bool> merge({
    required BrokerProfile survivor,
    required BrokerProfile removed,
    required BrokerRouteServer survivorRoutes,
    required BrokerRouteServer removedRoutes,
    required Map<String, String> chosenRouteByOrigin,
  }) async {
    if (survivor.id == removed.id ||
        survivor.sourceIdentity == null ||
        survivor.sourceIdentity != removed.sourceIdentity) {
      throw const BrokerRouteException('PRINCIPAL_CHANGED');
    }
    final from = RosterSource.ofProfile(removed).storageKey;
    final to = RosterSource.ofProfile(survivor).storageKey;
    await database.transaction(() async {
      for (final profile in [survivor, removed]) {
        final row = await database
            .customSelect(
              'SELECT incarnation_id, credential_key FROM broker_profile_rows '
              'WHERE id=?',
              variables: [Variable(profile.id)],
            )
            .getSingleOrNull();
        if (row?.readNullable<String>('incarnation_id') !=
                profile.incarnationId ||
            row?.readNullable<String>('credential_key') !=
                profile.credentialKey) {
          throw BrokerProfileRetiredException(profile.id);
        }
      }
      final kept = await routes.read(survivor.id, survivor.incarnationId!);
      final gone = await routes.read(removed.id, removed.incarnationId!);
      if (kept?.generation != survivorRoutes.generation ||
          gone?.generation != removedRoutes.generation ||
          kept?.sourceIdentity != survivor.sourceIdentity ||
          gone?.sourceIdentity != survivor.sourceIdentity) {
        throw const BrokerRouteException('CONFIGURATION_CHANGED');
      }
      final combined = [...kept!.addresses];
      for (final address in gone!.addresses) {
        final same = combined.where((a) => a.origin == address.origin).toList();
        if (same.any((a) => a.proxyId == address.proxyId)) continue;
        combined.add(address.copyWith(legacyTrusted: false));
      }
      final origins = combined.map((a) => a.origin.origin).toSet();
      for (final origin in origins) {
        final conflicts = combined
            .where((a) => a.origin.origin == origin)
            .toList();
        if (conflicts.length < 2) continue;
        final choice = chosenRouteByOrigin[origin];
        if (!conflicts.any((a) => a.id == choice)) {
          throw const BrokerRouteException('PROXY_CHOICE_REQUIRED');
        }
        for (var index = 0; index < combined.length; index++) {
          final address = combined[index];
          if (address.origin.origin == origin) {
            combined[index] = address.copyWith(
              enabled: address.id == choice,
              generation: address.generation + 1,
            );
          }
        }
      }
      // Preserve every different local draft before copying any ownership.
      final drafts = await database
          .customSelect(
            'SELECT * FROM session_draft_rows WHERE broker_profile_id=?',
            variables: [Variable(from)],
          )
          .get();
      for (final draft in drafts) {
        final collision = await database
            .customSelect(
              'SELECT * FROM session_draft_rows WHERE broker_profile_id=? AND '
              'tool=? AND session_id=?',
              variables: [
                Variable(to),
                Variable(draft.read<String>('tool')),
                Variable(draft.read<String>('session_id')),
              ],
            )
            .getSingleOrNull();
        if (collision == null) continue;
        if (collision.data['draft_text'] != draft.data['draft_text'] ||
            collision.data['conflict_text'] != draft.data['conflict_text'] ||
            collision.data['submitted_client_message_id'] !=
                draft.data['submitted_client_message_id']) {
          await database.customStatement(
            'INSERT INTO broker_recovered_drafts VALUES (?,?,?,?,?)',
            [
              to,
              draft.read<String>('tool'),
              draft.read<String>('session_id'),
              '$from#${newConnectionId()}',
              jsonEncode({...draft.data, 'serverName': removed.displayName}),
            ],
          );
        }
      }
      // A command's unknown outcome is never converted back to a queued send.
      // The existing failed-send surface requires deliberate review/retry.
      await database.customStatement(
        'UPDATE session_outbox_rows SET '
        "status='failed',last_error='SERVER_MERGE_REVIEW_REQUIRED' WHERE "
        "broker_profile_id IN (?,?) AND status!='delivered'",
        [from, to],
      );
      await database.customStatement(
        'UPDATE artifact_transfer_rows SET '
        "status='failed',error='SERVER_MERGE_REVIEW_REQUIRED' WHERE "
        "broker_profile_id=? AND status IN ('queued','running')",
        [from],
      );
      for (final table in brokerSourceTables) {
        if (table == 'roster_snapshot_rows' ||
            table == 'attention_cursor_rows' ||
            table == 'session_transcript_rows') {
          await database.customStatement(
            'DELETE FROM $table WHERE broker_profile_id IN (?,?)',
            [from, to],
          );
          continue;
        }
        if (table == 'attention_event_rows') {
          for (final field in [
            'local_read_at',
            'local_dismissed_at',
            'local_dismissed_revision',
            'local_presented_revision',
          ]) {
            final maximum =
                'max(coalesce($field,0),coalesce((SELECT incoming.$field FROM '
                '$table AS incoming WHERE incoming.broker_profile_id=? AND '
                'incoming.event_id=$table.event_id),0))';
            final merged = field == 'local_presented_revision'
                ? maximum
                : 'nullif($maximum,0)';
            await database.customStatement(
              'UPDATE $table SET $field=$merged WHERE broker_profile_id=?',
              [from, to],
            );
          }
        }
        final columns =
            (await database.customSelect('PRAGMA table_info($table)').get())
                .map((row) => row.read<String>('name'))
                .toList();
        final selectedColumns = columns
            .map((c) => c == 'broker_profile_id' ? '?' : c)
            .join(',');
        await database.customStatement(
          'INSERT OR IGNORE INTO $table (${columns.join(',')}) SELECT '
          '$selectedColumns FROM $table WHERE broker_profile_id=?',
          [to, from],
        );
        // Globally unique outbox/transfer IDs collide with themselves until
        // their source column is moved. No text-based message deduplication.
        if (table == 'session_outbox_rows' ||
            table == 'artifact_transfer_rows') {
          await database.customStatement(
            'UPDATE $table SET broker_profile_id=? WHERE broker_profile_id=?',
            [to, from],
          );
        }
        await database.customStatement(
          'DELETE FROM $table WHERE broker_profile_id=?',
          [from],
        );
      }
      for (final table in ['managed_device_files', 'device_storage_items']) {
        await database.customStatement(
          'UPDATE $table SET source=? WHERE source=?',
          [to, from],
        );
      }
      // A previous merge can have already recovered a version from this same
      // original source. Keep both versions rather than replacing either row.
      await database.customStatement(
        '''
UPDATE broker_recovered_drafts
        SET original_source=original_source || ?
        WHERE source=? AND EXISTS (SELECT 1 FROM broker_recovered_drafts AS
        prior
          WHERE prior.source=? AND prior.tool=broker_recovered_drafts.tool
          AND prior.session=broker_recovered_drafts.session
          AND prior.original_source=broker_recovered_drafts.original_source)''',
        ['#${newConnectionId()}', from, to],
      );
      await database.customStatement(
        'UPDATE broker_recovered_drafts SET source=? WHERE source=?',
        [to, from],
      );
      await _settings(from, to, removed.id);
      await _updates(removed, survivor);
      final formerFixed = kept.addresses
          .where((a) => a.id == kept.fixedRouteId)
          .firstOrNull;
      final fixed = formerFixed == null
          ? kept.fixedRouteId
          : chosenRouteByOrigin[formerFixed.origin.origin] ?? kept.fixedRouteId;
      await routes.save(
        kept.copyWith(addresses: combined, fixedRouteId: fixed),
        expectedGeneration: kept.generation,
      );
      // Selection moves with ownership in the same transaction, including when
      // the process stops before the UI receives the successful merge result.
      await database.customStatement(
        'UPDATE app_setting_rows SET value=?,updated_at=? WHERE key=? AND '
        'value=?',
        [
          survivor.id,
          DateTime.now().millisecondsSinceEpoch ~/ 1000,
          activeBrokerProfileSettingKey,
          removed.id,
        ],
      );
      await database.customStatement(
        'INSERT INTO broker_profile_merges VALUES (?,?,?,?,?,?)',
        [
          newConnectionId(),
          survivor.id,
          removed.id,
          removed.credentialKey,
          gone.pairingReference,
          'cleanup',
        ],
      );
      await database.customStatement(
        'INSERT INTO broker_route_migrations VALUES '
        "(?,?,?,?,?,'complete',NULL)",
        [removed.id, removed.incarnationId, from, to, removed.credentialKey],
      );
      await database.customStatement(
        'DELETE FROM broker_route_servers WHERE profile=? AND incarnation=?',
        [removed.id, removed.incarnationId],
      );
      await database.customStatement(
        'DELETE FROM broker_profile_rows WHERE id=? AND incarnation_id=?',
        [removed.id, removed.incarnationId],
      );
    });
    try {
      await recover();
      return true;
    } on Object {
      return false;
    } // Ownership committed; the cleanup journal is durable.
  }

  Future<void> _updates(BrokerProfile removed, BrokerProfile survivor) async {
    final saved = await database
        .customSelect(
          "SELECT value FROM app_setting_rows WHERE key='updates.v1'",
        )
        .getSingleOrNull();
    if (saved == null) return;
    final value =
        jsonDecode(saved.read<String>('value')) as Map<String, dynamic>;
    if (value['schemaVersion'] != 1) {
      throw const BrokerRouteException('MIGRATION_CONFLICT');
    }
    String scope(BrokerProfile p) => jsonEncode([
      p.id,
      p.incarnationId,
      p.sourceIdentity ?? p.baseUri.toString(),
      p.credentialKey,
    ]);
    final from = scope(removed);
    final to = scope(survivor);
    final servers = value['servers'] as Map<String, dynamic>?;
    if (servers?.containsKey(from) ?? false) {
      final observation = servers!.remove(from);
      servers.putIfAbsent(to, () => observation);
    }
    final operation = value['operation'] as Map<String, dynamic>?;
    for (final step in (operation?['steps'] as List?) ?? const []) {
      if (step is! Map || step['scope'] != from) continue;
      // Identity AND principal equality were checked before this transaction.
      // Preserve accepted job IDs and idempotency keys for reconciliation, but
      // require an explicit continuation after the saved connection changes.
      step['profileId'] = survivor.id;
      step['scope'] = to;
      if (!const ['succeeded', 'cancelled'].contains(step['phase'])) {
        operation!['phase'] = 'paused';
        operation['detailCode'] = 'update-source-changed';
      }
    }
    await database.customStatement(
      "UPDATE app_setting_rows SET value=? WHERE key='updates.v1'",
      [jsonEncode(value)],
    );
  }

  Future<void> _settings(
    String from,
    String to,
    String removedProfileId,
  ) async {
    final prefixes = brokerSourceSettingPrefixes(from, to);
    final settings = await database.select(database.appSettingRows).get();
    for (final setting in settings) {
      for (final prefix in prefixes.entries) {
        if (!brokerSourceSettingMatches(setting.key, prefix.key)) continue;
        final target =
            '${prefix.value}${setting.key.substring(prefix.key.length)}';
        final old = await database
            .customSelect(
              'SELECT value FROM app_setting_rows WHERE key=?',
              variables: [Variable(target)],
            )
            .getSingleOrNull();
        if (setting.key.startsWith('session_driving_intent:')) {
          // A remembered desire to drive is not a transferred lease.
        } else if (old != null &&
            setting.key.startsWith('open_file_panes_v1:')) {
          final first = FilePanesState.fromJsonString(
            old.read<String>('value'),
          );
          final second = FilePanesState.fromJsonString(setting.value);
          final panes = {
            ...{for (final p in second.panes) p.key: p},
            ...{for (final p in first.panes) p.key: p},
          }.values.toList();
          if (panes.length > FilePanesState.workingSetLimit) {
            throw const BrokerRouteException('TOO_MANY_OPEN_FILES');
          }
          final merged = FilePanesState(
            panes: panes,
            pinned: {...second.pinned, ...first.pinned},
            modes: {...second.modes, ...first.modes},
            activeBySession: {
              ...second.activeBySession,
              ...first.activeBySession,
            },
          );
          await database.customStatement(
            'UPDATE app_setting_rows SET value=? WHERE key=?',
            [merged.toJsonString(), target],
          );
        } else if (old == null) {
          await database.customStatement(
            'INSERT INTO app_setting_rows SELECT ?,value,updated_at FROM '
            'app_setting_rows WHERE key=?',
            [target, setting.key],
          );
        }
        await database.customStatement(
          'DELETE FROM app_setting_rows WHERE key=?',
          [setting.key],
        );
        break;
      }
    }
    for (final prefix in prefixes.keys) {
      await database.customStatement(
        'INSERT OR IGNORE INTO broker_retired_setting_prefixes VALUES (?,?)',
        [prefix, removedProfileId],
      );
    }
  }
}
