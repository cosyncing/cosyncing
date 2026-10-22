import 'dart:convert';
import 'dart:math';

import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_local_data_purge.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_routes.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart';

/// Drift-backed implementation of [BrokerProfileRepository].
class DriftBrokerProfileRepository implements BrokerProfileRepository {
  /// Creates a repository backed by [database].
  const DriftBrokerProfileRepository(this.database);

  /// Durable app database.
  final AppDatabase database;

  @override
  Future<List<BrokerProfile>> getAll() async {
    final rows = await database.customSelect(_profileWithRoute).get();
    final profiles = rows.map(_fromJoinedRow).toList()..sort(_compareProfiles);
    return profiles;
  }

  // A single database snapshot keeps the profile and its access binding
  // consistent, without a second browser-worker round trip during hydration.
  static const _profileWithRoute =
      'SELECT p.*, r.incarnation AS route_incarnation, '
      'r.payload AS route_payload FROM broker_profile_rows p '
      'LEFT JOIN broker_route_servers r ON r.profile=p.id';

  @override
  Future<BrokerProfile?> getById(String id) async {
    final row = await database
        .customSelect(
          '$_profileWithRoute WHERE p.id=?',
          variables: [Variable(id)],
        )
        .getSingleOrNull();
    return row == null ? null : _fromJoinedRow(row);
  }

  BrokerProfile _fromJoinedRow(QueryRow row) {
    final profile = _fromRow(database.brokerProfileRows.map(row.data));
    if (row.readNullable<String>('route_incarnation') !=
        profile.incarnationId) {
      return profile;
    }
    final routes = BrokerRouteServer.fromJson(
      jsonDecode(row.read<String>('route_payload')) as Map<String, dynamic>,
    );
    return profile.copyWith(sourceIdentity: routes.sourceIdentity);
  }

  /// Writes [profile], assigning a fresh incarnation when the id is new.
  ///
  /// A profile id that has no row yet is an ADDITION, and adding a broker is a
  /// new trust decision that must start from nothing. Deletion already purges
  /// what a profile owned, but it cannot fence a write that was already in
  /// flight when it ran. The new incarnation is the durable fence: a late
  /// writer retains the deleted generation in its scope key and cannot become
  /// addressable by this row.
  ///
  /// An existing id is an edit (rename, re-point, credential change, or the
  /// idempotent same-origin save on every web launch) and purges nothing.
  @override
  Future<BrokerProfile> save(BrokerProfile profile) async {
    return database.transaction(() async {
      final existing = await (database.select(
        database.brokerProfileRows,
      )..where((table) => table.id.equals(profile.id))).getSingleOrNull();
      if (existing == null) {
        if (profile.incarnationId != null) {
          throw BrokerProfileRetiredException(profile.id);
        }
        await BrokerProfileLocalDataPurge(
          database,
        ).deleteForProfile(profile.id);
        final saved = profile.copyWith(incarnationId: _newIncarnationId());
        await database
            .into(database.brokerProfileRows)
            .insert(
              _toCompanion(saved),
              mode: InsertMode.insert,
            );
        final routes = BrokerRouteServer.initial(
          profileId: saved.id,
          incarnation: saved.incarnationId!,
          origin: saved.baseUri,
          credentialReference: saved.credentialKey,
        );
        await database.customStatement(
          'INSERT INTO broker_route_servers VALUES (?,?,?)',
          [saved.id, saved.incarnationId, jsonEncode(routes.toJson())],
        );
        return saved;
      }

      final durableIncarnation =
          existing.incarnationId ?? _legacyIncarnationId(existing);
      if (profile.incarnationId != durableIncarnation) {
        throw BrokerProfileRetiredException(profile.id);
      }
      final saved = profile.copyWith(incarnationId: durableIncarnation);
      final updated =
          await (database.update(database.brokerProfileRows)..where(
                (table) =>
                    table.id.equals(profile.id) &
                    _matchesIncarnation(table, existing.incarnationId),
              ))
              .write(_toCompanion(saved));
      if (updated != 1) {
        throw BrokerProfileRetiredException(profile.id);
      }
      return saved;
    });
  }

  @override
  Future<bool> delete({
    required String id,
    required String? incarnationId,
  }) async {
    return database.transaction(() async {
      final existing = await (database.select(
        database.brokerProfileRows,
      )..where((table) => table.id.equals(id))).getSingleOrNull();
      if (existing == null) return false;
      final durableIncarnation =
          existing.incarnationId ?? _legacyIncarnationId(existing);
      if (incarnationId != durableIncarnation) return false;
      final deleted =
          await (database.delete(database.brokerProfileRows)..where(
                (table) =>
                    table.id.equals(id) &
                    _matchesIncarnation(table, existing.incarnationId),
              ))
              .go();
      return deleted == 1;
    });
  }

  static Expression<bool> _matchesIncarnation(
    BrokerProfileRows table,
    String? incarnationId,
  ) => incarnationId == null
      ? table.incarnationId.isNull()
      : table.incarnationId.equals(incarnationId);

  static BrokerProfile _fromRow(BrokerProfileRow row) {
    return BrokerProfile(
      id: row.id,
      displayName: row.displayName,
      baseUri: Uri.parse(row.baseUri),
      createdAt: row.createdAt,
      incarnationId: row.incarnationId ?? _legacyIncarnationId(row),
      updatedAt: row.updatedAt,
      lastUsedAt: row.lastUsedAt,
      credentialKey: row.credentialKey,
    );
  }

  static BrokerProfileRowsCompanion _toCompanion(BrokerProfile profile) {
    return BrokerProfileRowsCompanion(
      id: Value(profile.id),
      displayName: Value(profile.displayName),
      baseUri: Value(profile.baseUri.toString()),
      createdAt: Value(profile.createdAt),
      incarnationId: Value(profile.incarnationId),
      updatedAt: Value(profile.updatedAt),
      lastUsedAt: Value(profile.lastUsedAt),
      credentialKey: Value(profile.credentialKey),
    );
  }

  static int _compareProfiles(BrokerProfile a, BrokerProfile b) {
    final aLastUsedAt = a.lastUsedAt;
    final bLastUsedAt = b.lastUsedAt;

    if (aLastUsedAt != null && bLastUsedAt != null) {
      return bLastUsedAt.compareTo(aLastUsedAt);
    }
    if (aLastUsedAt != null) return -1;
    if (bLastUsedAt != null) return 1;
    return b.createdAt.compareTo(a.createdAt);
  }

  static String _newIncarnationId() {
    final random = Random.secure();
    final bytes = List<int>.generate(16, (_) => random.nextInt(256));
    return bytes.map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
  }

  static String _legacyIncarnationId(BrokerProfileRow row) =>
      'legacy-${Uri.encodeComponent(row.id)}-'
      '${row.createdAt.toUtc().microsecondsSinceEpoch}';
}
