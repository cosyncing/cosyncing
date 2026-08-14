import 'dart:convert';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_cache.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Maximum reduced messages persisted in one transcript snapshot.
///
/// A capped snapshot must never silently pretend completeness: when messages
/// are dropped, the persisted [SessionTranscriptSnapshot.truncation] carries
/// the honest `shown`/`total`, so hydration still surfaces the history-scope
/// notice and keeps `hasEarlier`/`olderCursor` for a broker-cursor
/// "Load earlier".
const int maxPersistedTranscriptMessages = 500;

/// Maximum transcript rows retained per broker profile.
///
/// The transcript cache is profile-scoped everywhere else (load/hydrate all
/// filter by broker profile), so eviction stays per-profile to preserve that
/// isolation: opening sessions under one broker never evicts another broker's
/// offline transcripts. On upsert, rows beyond this cap with the oldest
/// `updatedAt` are deleted in the same transaction, and the row just written is
/// never evicted.
const int maxRetainedTranscriptSessions = 100;

/// Maximum serialized bytes persisted in one transcript snapshot (DR1).
///
/// Count caps alone let one unusually large message dominate the cache. When
/// the encoded snapshot would exceed this budget, the oldest messages are
/// dropped with the same honest truncation metadata the count cap uses.
///
/// This is a HARD limit: a single message larger than the budget is omitted
/// entirely rather than retained as a guaranteed overflow. The stored snapshot
/// then honestly reports `shown: 0` against the real total, and the retained
/// `olderCursor`/`hasEarlier` still drive "Load earlier" — the agent transcript
/// remains authoritative for anything the cache cannot hold.
const int maxPersistedTranscriptBytesPerSession = 4 * 1024 * 1024;

/// Maximum serialized transcript bytes retained per broker profile (DR1).
///
/// Enforced inside the upsert transaction after the session-count eviction:
/// least-recently updated rows are deleted until the profile total fits. The
/// row just written is never evicted, so this is only a true bound while one
/// row cannot exceed it on its own — which
/// [maxPersistedTranscriptSnapshotBytes] guarantees.
const int maxRetainedTranscriptBytesPerProfile = 64 * 1024 * 1024;

/// Byte budget actually applied to one snapshot.
///
/// Taking the smaller of the two caps is what makes BOTH hard. The profile
/// eviction never deletes the row it just wrote, so if a single snapshot could
/// exceed the profile cap that cap would be unenforceable by construction. The
/// per-session budget is therefore clamped to the profile budget, and the
/// profile total is then bounded by evicting other sessions alone.
const int maxPersistedTranscriptSnapshotBytes =
    maxPersistedTranscriptBytesPerSession < maxRetainedTranscriptBytesPerProfile
    ? maxPersistedTranscriptBytesPerSession
    : maxRetainedTranscriptBytesPerProfile;

/// One transactionally committed transcript/checkpoint snapshot.
@immutable
final class SessionTranscriptSnapshot {
  /// Creates a durable transcript snapshot.
  const SessionTranscriptSnapshot({
    required this.brokerProfileId,
    required this.sessionKey,
    required this.messages,
    required this.hasEarlier,
    required this.updatedAt,
    this.cursor,
    this.olderCursor,
    this.gap,
    this.truncation,
  });

  /// Broker scope key (`RosterSource.storageKey`) of the broker that reported
  /// this transcript. Scoped to profile AND endpoint: a cached transcript is
  /// one broker's content, and an endpoint edit must leave it unreadable
  /// rather than display it as the new machine's session.
  final String brokerProfileId;

  /// Tool/session identity within [brokerProfileId].
  final SessionDetailKey sessionKey;

  /// Canonical reduced transcript and state messages.
  final List<AgentMessage> messages;

  /// Latest opaque reconnect cursor represented by [messages].
  final String? cursor;

  /// Opaque cursor for the next retained older page.
  final String? olderCursor;

  /// Whether [olderCursor] addresses another page.
  final bool hasEarlier;

  /// Honest broker cursor-gap metadata.
  final HistoryGap? gap;

  /// Honest broker tail-window metadata.
  final HistoryTruncation? truncation;

  /// Time at which the local transaction committed.
  final DateTime updatedAt;
}

/// Persistence boundary for session transcripts and reconnect checkpoints.
abstract interface class SessionTranscriptRepository {
  /// Loads the last committed snapshot for one profile-scoped session.
  Future<SessionTranscriptSnapshot?> load({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
  });

  /// Atomically replaces the snapshot and its represented cursor.
  Future<void> upsert(SessionTranscriptSnapshot snapshot);
}

/// Drift-backed transcript/checkpoint repository.
final class DriftSessionTranscriptRepository
    implements SessionTranscriptRepository {
  /// Creates a repository backed by [database].
  DriftSessionTranscriptRepository(
    this.database, {
    SessionCacheWriteFence? writeFence,
  }) : writeFence = writeFence ?? SessionCacheWriteFence();

  /// App-local durable database.
  final AppDatabase database;

  /// Shared cache-write admission boundary.
  final SessionCacheWriteFence writeFence;

  @override
  Future<SessionTranscriptSnapshot?> load({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
  }) async {
    final row =
        await (database.select(database.sessionTranscriptRows)..where(
              (candidate) =>
                  candidate.brokerProfileId.equals(brokerProfileId) &
                  candidate.tool.equals(sessionKey.tool) &
                  candidate.sessionId.equals(sessionKey.sessionId),
            ))
            .getSingleOrNull();
    if (row == null) return null;

    final decodedMessages = jsonDecode(row.messagesJson);
    if (decodedMessages is! List<Object?>) {
      throw const FormatException('Transcript messages must be a JSON list.');
    }
    final messages = <AgentMessage>[];
    for (final value in decodedMessages) {
      if (value is! Map<Object?, Object?>) {
        throw const FormatException(
          'Transcript messages must contain JSON objects.',
        );
      }
      messages.add(
        AgentMessage.fromJson(Map<String, dynamic>.from(value)),
      );
    }

    return SessionTranscriptSnapshot(
      brokerProfileId: brokerProfileId,
      sessionKey: sessionKey,
      messages: List<AgentMessage>.unmodifiable(messages),
      cursor: row.cursor,
      olderCursor: row.olderCursor,
      hasEarlier: row.hasEarlier && row.olderCursor != null,
      gap: _decodeOptionalMap(row.gapJson, HistoryGap.fromJson),
      truncation: _decodeOptionalMap(
        row.truncationJson,
        HistoryTruncation.fromJson,
      ),
      updatedAt: row.updatedAt,
    );
  }

  @override
  Future<void> upsert(SessionTranscriptSnapshot snapshot) {
    final bounded = _boundForPersistence(snapshot);
    final encoded = _encodeWithByteBudget(bounded.messages);
    final truncation = encoded.shown < bounded.messages.length
        ? HistoryTruncation(
            shown: encoded.shown,
            total: _maxInt(
              bounded.truncation?.total ?? 0,
              snapshot.messages.length,
            ),
          )
        : bounded.truncation;
    // The reconnect cursor says "resume after everything this row represents".
    // That claim is only true when the row represents the WHOLE snapshot. Any
    // local truncation — the count cap dropping older messages, the byte budget
    // dropping older ones, or the newest message itself being omitted — leaves
    // messages that are in no local row, and the cursor would tell the next
    // attach there is nothing to send. `hasEarlier`/`olderCursor` describe the
    // BROKER's boundary, not ours, so they cannot page those back either: when
    // the broker never truncated there is no older cursor at all.
    //
    // The store cannot mint a broker cursor for its own retained boundary, so
    // it drops the claim instead. With no cursor, bootstrap asks for
    // authoritative tail history and the broker's own reply re-establishes both
    // the messages and honest paging state. The cost is one full tail fetch on
    // reopen for a truncated session; the alternative is silently missing
    // messages.
    final locallyTruncated = encoded.shown < snapshot.messages.length;
    final companion = SessionTranscriptRowsCompanion.insert(
      brokerProfileId: bounded.brokerProfileId,
      tool: bounded.sessionKey.tool,
      sessionId: bounded.sessionKey.sessionId,
      messagesJson: encoded.messagesJson,
      cursor: Value(locallyTruncated ? null : bounded.cursor),
      olderCursor: Value(bounded.olderCursor),
      hasEarlier: Value(
        bounded.hasEarlier && bounded.olderCursor != null,
      ),
      gapJson: Value(
        bounded.gap == null ? null : jsonEncode(bounded.gap!.toJson()),
      ),
      truncationJson: Value(
        truncation == null ? null : jsonEncode(truncation.toJson()),
      ),
      updatedAt: bounded.updatedAt,
    );
    return writeFence.write(
      () => database.transaction(() async {
        await database
            .into(database.sessionTranscriptRows)
            .insertOnConflictUpdate(companion);
        await _evictBeyondSessionCap(bounded);
        await _evictBeyondByteCap(bounded);
      }),
    );
  }

  /// Encodes [messages] as the stored JSON list, dropping the oldest entries
  /// until the serialized form fits [maxPersistedTranscriptSnapshotBytes].
  ///
  /// The budget is a hard ceiling, so a newest message that alone exceeds it is
  /// omitted and the result is an empty list. Retaining it "so the snapshot is
  /// never empty" would make the advertised cap a suggestion and let one
  /// pathological message set the cache size. The returned `shown` count
  /// reports how many entries survived, so the caller keeps truncation metadata
  /// honest and the broker cursor still fetches what the cache dropped.
  ({String messagesJson, int shown}) _encodeWithByteBudget(
    List<AgentMessage> messages,
  ) {
    if (messages.isEmpty) return (messagesJson: '[]', shown: 0);
    final encoded = messages
        .map((message) => jsonEncode(message.toJson()))
        .toList(growable: false);
    // Accumulate newest-first: serialized length is '[' + entries + commas +
    // ']', so each entry after the first also costs its separator.
    var bytes = 2;
    var shown = 0;
    for (var index = encoded.length - 1; index >= 0; index--) {
      final next = bytes + utf8Length(encoded[index]) + (shown == 0 ? 0 : 1);
      if (next > maxPersistedTranscriptSnapshotBytes) break;
      bytes = next;
      shown++;
    }
    if (shown == 0) return (messagesJson: '[]', shown: 0);
    final retained = encoded.sublist(encoded.length - shown);
    return (messagesJson: '[${retained.join(',')}]', shown: shown);
  }

  /// Deletes the least-recently updated rows for this snapshot's profile until
  /// the profile's serialized transcript bytes fit
  /// [maxRetainedTranscriptBytesPerProfile], keeping the just-written row.
  ///
  /// Excluding the just-written row is only sound because
  /// [maxPersistedTranscriptSnapshotBytes] bounds one row at or below the
  /// profile budget: evicting every OTHER row therefore always suffices, so the
  /// profile cap is a real limit rather than "the cap plus one snapshot".
  ///
  /// Runs inside the upsert transaction and is bounded by the session-count
  /// cap: each iteration deletes exactly one row via the
  /// `idx_session_transcript_profile_updated` index, and the loop can never
  /// exceed [maxRetainedTranscriptSessions] deletions.
  Future<void> _evictBeyondByteCap(SessionTranscriptSnapshot snapshot) async {
    for (var guard = 0; guard < maxRetainedTranscriptSessions; guard++) {
      final total = await database
          .customSelect(
            'SELECT COALESCE(SUM(LENGTH(CAST(messages_json AS BLOB))), 0) '
            'AS total_bytes FROM session_transcript_rows '
            'WHERE broker_profile_id = ?',
            variables: [Variable.withString(snapshot.brokerProfileId)],
          )
          .getSingle();
      if (total.read<int>('total_bytes') <=
          maxRetainedTranscriptBytesPerProfile) {
        return;
      }
      final deleted = await database.customUpdate(
        'DELETE FROM session_transcript_rows '
        'WHERE broker_profile_id = ? '
        'AND NOT (tool = ? AND session_id = ?) '
        'AND rowid IN ('
        ' SELECT rowid FROM session_transcript_rows '
        ' WHERE broker_profile_id = ? '
        '   AND NOT (tool = ? AND session_id = ?) '
        ' ORDER BY updated_at ASC, tool ASC, session_id ASC LIMIT 1)',
        variables: [
          Variable.withString(snapshot.brokerProfileId),
          Variable.withString(snapshot.sessionKey.tool),
          Variable.withString(snapshot.sessionKey.sessionId),
          Variable.withString(snapshot.brokerProfileId),
          Variable.withString(snapshot.sessionKey.tool),
          Variable.withString(snapshot.sessionKey.sessionId),
        ],
        updateKind: UpdateKind.delete,
      );
      if (deleted == 0) return; // only the just-written row remains
    }
  }

  /// Caps a snapshot to [maxPersistedTranscriptMessages] most-recent messages.
  ///
  /// Dropping the oldest messages would silently under-represent the session,
  /// so a capped snapshot records an honest [HistoryTruncation]. Hydration
  /// then surfaces `shown`/`total`, and the retained broker
  /// `olderCursor`/`hasEarlier` still drive "Load earlier". The reconnect
  /// cursor represents the newest message and is unaffected by dropping older
  /// ones.
  SessionTranscriptSnapshot _boundForPersistence(
    SessionTranscriptSnapshot snapshot,
  ) {
    final total = snapshot.messages.length;
    if (total <= maxPersistedTranscriptMessages) return snapshot;
    final retained = List<AgentMessage>.unmodifiable(
      snapshot.messages.sublist(total - maxPersistedTranscriptMessages),
    );
    final brokerTotal = snapshot.truncation?.total ?? 0;
    return SessionTranscriptSnapshot(
      brokerProfileId: snapshot.brokerProfileId,
      sessionKey: snapshot.sessionKey,
      messages: retained,
      cursor: snapshot.cursor,
      olderCursor: snapshot.olderCursor,
      hasEarlier: snapshot.hasEarlier,
      gap: snapshot.gap,
      truncation: HistoryTruncation(
        shown: maxPersistedTranscriptMessages,
        total: brokerTotal > total ? brokerTotal : total,
      ),
      updatedAt: snapshot.updatedAt,
    );
  }

  /// Deletes the oldest-`updatedAt` rows for this snapshot's profile beyond
  /// [maxRetainedTranscriptSessions], keeping the just-written row.
  ///
  /// Runs inside the upsert transaction. The just-written `(tool, sessionId)`
  /// is excluded from both the delete set and the retained set, so at most the
  /// cap rows survive (the written row plus the newest `cap - 1` others) and
  /// the written row is never evicted, even under equal timestamps.
  Future<void> _evictBeyondSessionCap(
    SessionTranscriptSnapshot snapshot,
  ) async {
    await database.customStatement(
      '''
      DELETE FROM session_transcript_rows
      WHERE broker_profile_id = ?
        AND NOT (tool = ? AND session_id = ?)
        AND (tool, session_id) NOT IN (
          SELECT tool, session_id FROM session_transcript_rows
          WHERE broker_profile_id = ?
            AND NOT (tool = ? AND session_id = ?)
          ORDER BY updated_at DESC, tool DESC, session_id DESC
          LIMIT ?
        )
      ''',
      <Object?>[
        snapshot.brokerProfileId,
        snapshot.sessionKey.tool,
        snapshot.sessionKey.sessionId,
        snapshot.brokerProfileId,
        snapshot.sessionKey.tool,
        snapshot.sessionKey.sessionId,
        maxRetainedTranscriptSessions - 1,
      ],
    );
  }
}

T? _decodeOptionalMap<T>(
  String? encoded,
  T Function(Map<String, dynamic>) decode,
) {
  if (encoded == null) return null;
  final value = jsonDecode(encoded);
  if (value is! Map<Object?, Object?>) {
    throw const FormatException('Transcript metadata must be a JSON object.');
  }
  return decode(Map<String, dynamic>.from(value));
}

/// UTF-8 byte length of one already-encoded JSON fragment.
int utf8Length(String value) => utf8.encode(value).length;

int _maxInt(int a, int b) => a > b ? a : b;

/// Profile-scoped durable transcript repository.
final sessionTranscriptRepositoryProvider =
    Provider<SessionTranscriptRepository>(
      (ref) => DriftSessionTranscriptRepository(
        ref.watch(appDatabaseProvider),
        writeFence: ref.watch(sessionCacheWriteFenceProvider),
      ),
    );
