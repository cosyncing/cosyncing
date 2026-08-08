import 'dart:convert';
import 'dart:developer' as developer;

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_cache_write_fence.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_roster_identity.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Persistence boundary for the bounded roster identity snapshot (N3).
abstract interface class RosterSnapshotRepository {
  /// Loads one profile's snapshot, or null when there is nothing usable.
  ///
  /// Corrupt, future-version, expired, over-bound and foreign-[endpoint] rows
  /// all resolve to null AND are deleted: a snapshot the client cannot trust
  /// must not linger to be re-examined on every start.
  ///
  /// [endpoint] is the profile's current normalized broker URL. A profile keeps
  /// its id when that URL is edited, so the id alone does not identify the
  /// roster source.
  Future<SessionRosterSnapshot?> load(
    String brokerProfileId, {
    required String endpoint,
  });

  /// Replaces one profile's snapshot from an authoritative roster response.
  ///
  /// Returns what was actually stored after every bound was applied.
  Future<SessionRosterSnapshot> save({
    required String brokerProfileId,
    required String endpoint,
    required List<SessionInfo> sessions,
    DateTime? now,
  });

  /// Removes one profile's snapshot (profile deletion).
  Future<void> deleteForProfile(String brokerProfileId);
}

/// Drift-backed roster snapshot repository.
///
/// Every published bound in `session_roster_identity.dart` is enforced on the
/// WRITE path — row count and bytes before the row is encoded, profile count
/// and aggregate bytes in the same transaction as the upsert — plus a bounded
/// opportunistic sweep for age. There is no timer anywhere in this file: the
/// only thing that triggers work is a real authoritative roster response.
final class DriftRosterSnapshotRepository implements RosterSnapshotRepository {
  /// Creates a repository backed by [database].
  DriftRosterSnapshotRepository(
    this.database, {
    SessionCacheWriteFence? writeFence,
  }) : writeFence = writeFence ?? SessionCacheWriteFence();

  /// App-local durable database.
  final AppDatabase database;

  /// Shared cache-write admission boundary.
  final SessionCacheWriteFence writeFence;

  @override
  Future<SessionRosterSnapshot?> load(
    String brokerProfileId, {
    required String endpoint,
  }) async {
    final row =
        await (database.select(database.rosterSnapshotRows)..where(
              (candidate) => candidate.brokerProfileId.equals(brokerProfileId),
            ))
            .getSingleOrNull();
    if (row == null) return null;

    if (row.endpoint != endpoint) {
      // Same profile, different broker. Editing a profile's URL keeps its id,
      // so without this the new broker's roster would hydrate from the previous
      // broker's session identities — cross-broker leakage under a name the
      // user believes they repointed.
      await _discard(brokerProfileId, 'endpoint changed');
      return null;
    }

    if (row.payloadVersion != rosterSnapshotPayloadVersion) {
      // Either an older shape this build no longer reads, or one written by a
      // NEWER build. Both fail open; neither is guessed at.
      await _discard(brokerProfileId, 'payload version ${row.payloadVersion}');
      return null;
    }

    final age = DateTime.now().difference(row.capturedAt);
    if (age.isNegative || age > maxRosterSnapshotAge) {
      // A future `capturedAt` is as untrustworthy as an expired one — a clock
      // moved backwards would otherwise pin a snapshot as permanently fresh.
      await _discard(brokerProfileId, 'expired (age ${age.inDays}d)');
      return null;
    }

    // The bound is in ENCODED bytes, so it has to be measured in them. String
    // length counts UTF-16 code units, which under-reports every non-ASCII
    // character — a payload of CJK titles or emoji is three to four bytes per
    // unit, so a row well past the budget would read as comfortably inside it
    // and the cap would silently stop being a cap.
    final encodedBytes = utf8.encode(row.rowsJson).length;
    if (encodedBytes > maxRosterSnapshotBytes) {
      await _discard(brokerProfileId, 'oversized ($encodedBytes bytes)');
      return null;
    }

    final List<SessionRosterIdentity> rows;
    try {
      rows = decodeRosterSnapshotRows(row.rowsJson);
    } on Object catch (error) {
      await _discard(brokerProfileId, 'unreadable payload: $error');
      return null;
    }

    return SessionRosterSnapshot(
      brokerProfileId: brokerProfileId,
      rows: rows,
      capturedAt: row.capturedAt,
      // `rowCount` is what the writer claimed; a mismatch means the row was
      // truncated on the way in or out, so report the honest difference rather
      // than the claim.
      omittedRowCount: row.rowCount > rows.length
          ? row.rowCount - rows.length
          : 0,
      newestSessionUpdatedAt: row.newestSessionUpdatedAt,
    );
  }

  @override
  Future<SessionRosterSnapshot> save({
    required String brokerProfileId,
    required String endpoint,
    required List<SessionInfo> sessions,
    DateTime? now,
  }) => writeFence.write(() async {
    final capturedAt = now ?? DateTime.now();
    final bounded = boundRosterSnapshotPayload(sessions);
    await database.transaction(() async {
      await database
          .into(database.rosterSnapshotRows)
          .insertOnConflictUpdate(
            RosterSnapshotRowsCompanion.insert(
              brokerProfileId: brokerProfileId,
              endpoint: endpoint,
              payloadVersion: rosterSnapshotPayloadVersion,
              rowsJson: bounded.rowsJson,
              rowCount: Value(bounded.rows.length + bounded.omittedRowCount),
              newestSessionUpdatedAt: Value(bounded.newestSessionUpdatedAt),
              capturedAt: capturedAt,
            ),
          );
      await _evictBeyondProfileCap(brokerProfileId);
      await _evictBeyondAggregateBytes(brokerProfileId);
      await _pruneExpired(brokerProfileId, capturedAt);
    });
    return SessionRosterSnapshot(
      brokerProfileId: brokerProfileId,
      rows: bounded.rows,
      capturedAt: capturedAt,
      omittedRowCount: bounded.omittedRowCount,
      newestSessionUpdatedAt: bounded.newestSessionUpdatedAt,
    );
  });

  @override
  Future<void> deleteForProfile(String brokerProfileId) async {
    await (database.delete(
      database.rosterSnapshotRows,
    )..where((row) => row.brokerProfileId.equals(brokerProfileId))).go();
  }

  Future<void> _discard(String brokerProfileId, String reason) async {
    developer.log(
      'roster-snapshot discarded profile=$brokerProfileId reason=$reason',
      name: 'cosyncing.sessions',
    );
    await deleteForProfile(brokerProfileId);
  }

  /// Keeps at most [maxRetainedRosterSnapshotProfiles] profiles, evicting the
  /// least-recently captured. The just-written profile is always excluded from
  /// the delete set, so a save can never evict what it just stored.
  Future<void> _evictBeyondProfileCap(String brokerProfileId) {
    return database.customStatement(
      '''
      DELETE FROM roster_snapshot_rows
      WHERE broker_profile_id != ?
        AND broker_profile_id NOT IN (
          SELECT broker_profile_id FROM roster_snapshot_rows
          WHERE broker_profile_id != ?
          ORDER BY captured_at DESC, broker_profile_id DESC
          LIMIT ?
        )
      ''',
      <Object?>[
        brokerProfileId,
        brokerProfileId,
        maxRetainedRosterSnapshotProfiles - 1,
      ],
    );
  }

  /// Deletes least-recently-captured profiles until the aggregate encoded size
  /// fits [maxRetainedRosterSnapshotBytesTotal].
  ///
  /// Excluding the just-written row is only sound because
  /// [maxRosterSnapshotBytes] bounds one row far below the aggregate ceiling,
  /// so evicting every OTHER profile always suffices. The loop is bounded by
  /// the profile cap: each iteration deletes exactly one row.
  Future<void> _evictBeyondAggregateBytes(String brokerProfileId) async {
    for (var guard = 0; guard < maxRetainedRosterSnapshotProfiles; guard++) {
      final total = await database
          .customSelect(
            'SELECT COALESCE(SUM(LENGTH(CAST(rows_json AS BLOB))), 0) '
            'AS total_bytes FROM roster_snapshot_rows',
          )
          .getSingle();
      if (total.read<int>('total_bytes') <=
          maxRetainedRosterSnapshotBytesTotal) {
        return;
      }
      final deleted = await database.customUpdate(
        'DELETE FROM roster_snapshot_rows WHERE broker_profile_id IN ('
        ' SELECT broker_profile_id FROM roster_snapshot_rows '
        ' WHERE broker_profile_id != ? '
        ' ORDER BY captured_at ASC, broker_profile_id ASC LIMIT 1)',
        variables: [Variable.withString(brokerProfileId)],
        updateKind: UpdateKind.delete,
      );
      if (deleted == 0) return; // only the just-written row is left
    }
  }

  /// Opportunistic, timer-free age sweep, bounded to one batch per save.
  Future<void> _pruneExpired(String brokerProfileId, DateTime now) {
    final cutoff = now.subtract(maxRosterSnapshotAge);
    return database.customUpdate(
      'DELETE FROM roster_snapshot_rows WHERE rowid IN ('
      ' SELECT rowid FROM roster_snapshot_rows '
      ' WHERE broker_profile_id != ? AND captured_at < ? '
      ' ORDER BY captured_at ASC LIMIT ?)',
      variables: [
        Variable.withString(brokerProfileId),
        Variable.withInt(cutoff.millisecondsSinceEpoch ~/ 1000),
        Variable.withInt(rosterSnapshotCleanupBatchLimit),
      ],
      updateKind: UpdateKind.delete,
    );
  }
}

/// Profile-scoped durable roster identity snapshot repository.
final rosterSnapshotRepositoryProvider = Provider<RosterSnapshotRepository>(
  (ref) => DriftRosterSnapshotRepository(
    ref.watch(appDatabaseProvider),
    writeFence: ref.watch(sessionCacheWriteFenceProvider),
  ),
);
