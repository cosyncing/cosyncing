import 'dart:convert';

import 'package:cosyncing_client/src/features/sessions/model/session_ref.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Key prefix for a broker profile's persisted opened-sessions working set.
const String openSessionsSettingKeyPrefix = 'open_sessions:';

/// Prefix for PV1's per-session, exact-source working-set records.
///
/// Unlike [openSessionsSettingKeyPrefix], each row owns one session only. A
/// second window can therefore add, close, refresh, or reorder one session
/// without replacing another window's complete tab snapshot.
const String openSessionMembershipSettingKeyPrefix = 'open_session_v2:';

/// Prefix for the restart-only active-session hint.
///
/// This row is deliberately never watched. The active tab belongs to a window;
/// the last writer is useful only as a cold-start hint and has no live
/// navigation authority over another window.
const String openSessionsActiveHintSettingKeyPrefix =
    'open_sessions_active_hint_v2:';

/// One-time marker preventing a closed v2 set from re-importing legacy rows.
const String openSessionsMigrationSettingKeyPrefix =
    'open_sessions_migrated_v2:';

/// A persisted snapshot of one broker profile's opened-sessions working set.
@immutable
class OpenSessionsSnapshot {
  /// Creates a snapshot.
  const OpenSessionsSnapshot({required this.refs, this.activeKey});

  /// Decodes a snapshot from its persisted JSON string. Returns [empty] on any
  /// malformed input, so a bad record can never wedge startup.
  factory OpenSessionsSnapshot.fromJsonString(String value) {
    try {
      final decoded = jsonDecode(value);
      if (decoded is! Map<String, dynamic>) {
        return empty;
      }
      final rawRefs = decoded['refs'];
      final refs = <SessionRef>[
        if (rawRefs is List)
          for (final entry in rawRefs)
            if (entry is Map<String, dynamic>) SessionRef.fromJson(entry),
      ];
      return OpenSessionsSnapshot(
        refs: refs,
        activeKey: decoded['active'] as String?,
      );
    } on Object {
      return empty;
    }
  }

  /// An empty working set.
  static const OpenSessionsSnapshot empty = OpenSessionsSnapshot(refs: []);

  /// The ordered open sessions.
  final List<SessionRef> refs;

  /// The [SessionRef.key] of the active tab, or null.
  final String? activeKey;

  /// Encodes this snapshot to a JSON string for persistence.
  String toJsonString() => jsonEncode(<String, dynamic>{
    'active': activeKey,
    'refs': [for (final ref in refs) ref.toJson()],
  });
}

/// Durable, per-broker-profile store for the opened-sessions working set.
///
/// Backed by the shared `appSettingRows` KV table (one JSON record per profile)
/// rather than a bespoke table, so tabs survive restarts without a schema
/// migration. See `docs/architecture/client-ui.md`.
abstract interface class OpenSessionsStore {
  /// Loads the working set for [profileId] (empty if none saved).
  Future<OpenSessionsSnapshot> load(String profileId);

  /// Persists the working set for [profileId].
  Future<void> save(String profileId, OpenSessionsSnapshot snapshot);
}

/// Operation-based working-set store used by production.
///
/// Kept as a refinement of [OpenSessionsStore] so small test doubles written
/// for the legacy snapshot contract remain valid. The controller uses this
/// interface whenever available and falls back to the old interface only for
/// those isolated tests.
abstract interface class LosslessOpenSessionsStore
    implements OpenSessionsStore {
  /// Loads exact-source membership plus the startup-only active hint.
  Future<OpenSessionsSnapshot> loadLossless(
    String sourceKey, {
    String? legacyProfileId,
  });

  /// Observes membership changes for [sourceKey].
  ///
  /// The stream never carries active-tab state.
  Stream<List<SessionRef>> watchMembership(String sourceKey);

  /// Adds or refreshes one member without replacing any other member.
  Future<void> openMember(String sourceKey, SessionRef entry);

  /// Removes one member without rewriting the remaining set.
  Future<void> closeMember(String sourceKey, String sessionKey);

  /// Removes the caller-visible members named by [sessionKeys].
  Future<void> closeOtherMembers(
    String sourceKey,
    List<String> sessionKeys,
  );

  /// Reorders only members that still exist when the transaction runs.
  Future<void> reorderMembers(String sourceKey, List<String> orderedKeys);

  /// Refreshes metadata only for members that still exist.
  Future<void> refreshMemberMetadata(
    String sourceKey,
    List<SessionRef> entries,
  );

  /// Saves a restart hint. It is never emitted by [watchMembership].
  Future<void> saveActiveHint(String sourceKey, String? sessionKey);
}

@immutable
final class _OpenSessionMembership {
  const _OpenSessionMembership({
    required this.sourceKey,
    required this.ref,
    required this.order,
  });

  factory _OpenSessionMembership.fromJsonString(String value) {
    final decoded = jsonDecode(value);
    if (decoded is! Map<String, dynamic>) {
      throw const FormatException('membership must be an object');
    }
    final sourceKey = decoded['source'];
    final ref = decoded['ref'];
    final order = decoded['order'];
    if (sourceKey is! String || ref is! Map<String, dynamic> || order is! int) {
      throw const FormatException('invalid membership');
    }
    return _OpenSessionMembership(
      sourceKey: sourceKey,
      ref: SessionRef.fromJson(ref),
      order: order,
    );
  }

  final String sourceKey;
  final SessionRef ref;
  final int order;

  String toJsonString() => jsonEncode(<String, Object?>{
    'source': sourceKey,
    'ref': ref.toJson(),
    'order': order,
  });

  _OpenSessionMembership copyWith({SessionRef? ref, int? order}) =>
      _OpenSessionMembership(
        sourceKey: sourceKey,
        ref: ref ?? this.ref,
        order: order ?? this.order,
      );
}

/// Drift-backed [OpenSessionsStore] over the shared app settings table.
class DriftOpenSessionsStore implements LosslessOpenSessionsStore {
  /// Creates the store over [database].
  DriftOpenSessionsStore(this.database);

  /// App-local durable database.
  final AppDatabase database;

  String _settingKey(String profileId) =>
      '$openSessionsSettingKeyPrefix$profileId';

  String _encodedKey(String value) => utf8
      .encode(value)
      .map((byte) => byte.toRadixString(16).padLeft(2, '0'))
      .join();

  String _membershipPrefix(String sourceKey) =>
      '$openSessionMembershipSettingKeyPrefix${_encodedKey(sourceKey)}:';

  String _membershipKey(String sourceKey, String sessionKey) =>
      '${_membershipPrefix(sourceKey)}${_encodedKey(sessionKey)}';

  String _activeHintKey(String sourceKey) =>
      '$openSessionsActiveHintSettingKeyPrefix${_encodedKey(sourceKey)}';

  String _migrationKey(String profileId) =>
      '$openSessionsMigrationSettingKeyPrefix${_encodedKey(profileId)}';

  @override
  Future<OpenSessionsSnapshot> load(String profileId) async {
    final query = database.select(database.appSettingRows)
      ..where((table) => table.key.equals(_settingKey(profileId)));
    final row = await query.getSingleOrNull();
    final value = row?.value;
    if (value == null || value.isEmpty) {
      return OpenSessionsSnapshot.empty;
    }
    return OpenSessionsSnapshot.fromJsonString(value);
  }

  @override
  Future<void> save(String profileId, OpenSessionsSnapshot snapshot) async {
    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: _settingKey(profileId),
            value: snapshot.toJsonString(),
            updatedAt: DateTime.now(),
          ),
        );
  }

  @override
  Future<OpenSessionsSnapshot> loadLossless(
    String sourceKey, {
    String? legacyProfileId,
  }) async {
    await _migrateLegacyOnce(sourceKey, legacyProfileId);
    final memberships = await _loadMemberships(sourceKey);
    final hintQuery = database.select(database.appSettingRows)
      ..where((table) => table.key.equals(_activeHintKey(sourceKey)));
    final hint = await hintQuery.getSingleOrNull();
    final active = hint?.value;
    return OpenSessionsSnapshot(
      refs: [for (final membership in memberships) membership.ref],
      activeKey:
          active != null &&
              memberships.any((membership) => membership.ref.key == active)
          ? active
          : null,
    );
  }

  @override
  Stream<List<SessionRef>> watchMembership(String sourceKey) {
    final query = database.select(database.appSettingRows)
      ..where(
        (table) => table.key.like('${_membershipPrefix(sourceKey)}%'),
      );
    return query
        .watch()
        .map((rows) {
          final memberships = _decodeMemberships(rows, sourceKey);
          return List<SessionRef>.unmodifiable([
            for (final membership in memberships) membership.ref,
          ]);
        })
        .distinct(listEquals);
  }

  @override
  Future<void> openMember(String sourceKey, SessionRef entry) {
    return database.transaction(() async {
      final memberships = await _loadMemberships(sourceKey);
      final existing = memberships
          .where((membership) => membership.ref.key == entry.key)
          .firstOrNull;
      final order =
          existing?.order ??
          (memberships.isEmpty ? 1024 : memberships.last.order + 1024);
      await _writeMembership(
        _OpenSessionMembership(
          sourceKey: sourceKey,
          ref: entry,
          order: order,
        ),
      );
    });
  }

  @override
  Future<void> closeMember(String sourceKey, String sessionKey) {
    return (database.delete(database.appSettingRows)..where(
          (table) => table.key.equals(_membershipKey(sourceKey, sessionKey)),
        ))
        .go();
  }

  @override
  Future<void> closeOtherMembers(
    String sourceKey,
    List<String> sessionKeys,
  ) {
    return database.transaction(() async {
      for (final sessionKey in sessionKeys.toSet()) {
        await (database.delete(database.appSettingRows)..where(
              (table) => table.key.equals(
                _membershipKey(sourceKey, sessionKey),
              ),
            ))
            .go();
      }
    });
  }

  @override
  Future<void> reorderMembers(String sourceKey, List<String> orderedKeys) {
    return database.transaction(() async {
      final memberships = await _loadMemberships(sourceKey);
      final byKey = {
        for (final membership in memberships) membership.ref.key: membership,
      };
      var order = 1024;
      for (final key in orderedKeys) {
        final membership = byKey.remove(key);
        if (membership == null) continue;
        await _writeMembership(membership.copyWith(order: order));
        order += 1024;
      }
      // A member opened by another window after this window formed its reorder
      // intent is not dropped or pulled into the middle. It remains after the
      // explicitly ordered set in its current relative order.
      for (final membership in memberships) {
        if (!byKey.containsKey(membership.ref.key)) continue;
        await _writeMembership(membership.copyWith(order: order));
        order += 1024;
      }
    });
  }

  @override
  Future<void> refreshMemberMetadata(
    String sourceKey,
    List<SessionRef> entries,
  ) {
    return database.transaction(() async {
      final memberships = await _loadMemberships(sourceKey);
      final updates = {for (final entry in entries) entry.key: entry};
      for (final membership in memberships) {
        final update = updates[membership.ref.key];
        if (update == null || update == membership.ref) continue;
        await _writeMembership(membership.copyWith(ref: update));
      }
    });
  }

  @override
  Future<void> saveActiveHint(String sourceKey, String? sessionKey) async {
    final key = _activeHintKey(sourceKey);
    if (sessionKey == null) {
      await (database.delete(
        database.appSettingRows,
      )..where((table) => table.key.equals(key))).go();
      return;
    }
    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: key,
            value: sessionKey,
            updatedAt: DateTime.now(),
          ),
        );
  }

  Future<List<_OpenSessionMembership>> _loadMemberships(
    String sourceKey,
  ) async {
    final query = database.select(database.appSettingRows)
      ..where(
        (table) => table.key.like('${_membershipPrefix(sourceKey)}%'),
      );
    return _decodeMemberships(await query.get(), sourceKey);
  }

  Future<void> _migrateLegacyOnce(
    String sourceKey,
    String? legacyProfileId,
  ) {
    return database.transaction(() async {
      // A bare profile id has no endpoint/incarnation identity. It may be
      // consumed by exactly one exact source; copying it into every source
      // would let an old machine's tabs appear after A→B or delete/re-add.
      if (legacyProfileId == null) return;
      final markerQuery = database.select(database.appSettingRows)
        ..where((table) => table.key.equals(_migrationKey(legacyProfileId)));
      if (await markerQuery.getSingleOrNull() != null) return;

      final memberships = await _loadMemberships(sourceKey);
      if (memberships.isEmpty) {
        final legacy = await load(legacyProfileId);
        var order = 1024;
        for (final ref in legacy.refs) {
          await _writeMembership(
            _OpenSessionMembership(
              sourceKey: sourceKey,
              ref: ref,
              order: order,
            ),
          );
          order += 1024;
        }
        if (legacy.activeKey != null) {
          await saveActiveHint(sourceKey, legacy.activeKey);
        }
      }
      // Consume even an empty/malformed legacy row. The global marker is the
      // fail-closed authority; deleting the ambiguous source prevents a later
      // endpoint incarnation from importing it through older client code.
      await (database.delete(database.appSettingRows)..where(
            (table) => table.key.equals(_settingKey(legacyProfileId)),
          ))
          .go();
      await database
          .into(database.appSettingRows)
          .insertOnConflictUpdate(
            AppSettingRowsCompanion.insert(
              key: _migrationKey(legacyProfileId),
              value: sourceKey,
              updatedAt: DateTime.now(),
            ),
          );
    });
  }

  List<_OpenSessionMembership> _decodeMemberships(
    List<AppSettingRow> rows,
    String sourceKey,
  ) {
    final memberships = <_OpenSessionMembership>[];
    for (final row in rows) {
      try {
        final membership = _OpenSessionMembership.fromJsonString(row.value);
        if (membership.sourceKey == sourceKey) memberships.add(membership);
      } on Object {
        // One malformed lightweight setting must not wedge the whole workspace.
      }
    }
    memberships.sort((a, b) {
      final byOrder = a.order.compareTo(b.order);
      return byOrder != 0 ? byOrder : a.ref.key.compareTo(b.ref.key);
    });
    return memberships;
  }

  Future<void> _writeMembership(_OpenSessionMembership membership) {
    return database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: _membershipKey(
              membership.sourceKey,
              membership.ref.key,
            ),
            value: membership.toJsonString(),
            updatedAt: DateTime.now(),
          ),
        );
  }
}

/// Provider for the durable opened-sessions store.
final openSessionsStoreProvider = Provider<OpenSessionsStore>((ref) {
  return DriftOpenSessionsStore(ref.watch(appDatabaseProvider));
});
