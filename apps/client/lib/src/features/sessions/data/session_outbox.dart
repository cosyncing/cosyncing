import 'dart:async';
import 'dart:convert';

import 'package:cosyncing_client/src/features/sessions/data/session_detail_state.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Short retry window for broker in-memory dedupe.
///
/// The broker forgets dedupe state on restart/session re-adopt, so the app
/// avoids silent long-tail replays that could execute a mutating action twice.
const sessionOutboxRetryWindow = Duration(minutes: 2);

/// Maximum automatic send attempts for one outbox row.
const sessionOutboxMaxAttempts = 3;

/// Grace period before a delivered row's stripped shell is deleted (DR1).
///
/// The payload itself is removed immediately on broker delivery (the agent
/// transcript owns delivered history; the row is never replayed). The shell
/// survives briefly so late receipts and diagnostics stay harmless and
/// idempotent, then bounded cleanup deletes it.
const sessionOutboxDeliveredRetention = Duration(hours: 24);

/// Finite fallback retention for abandoned failed rows (DR1).
///
/// A failed row the user never resolves keeps its payload for draft recovery
/// until this TTL expires; cleanup then deletes it. Active failures are newer
/// than the TTL and are never hidden.
const sessionOutboxFailedRetention = Duration(days: 30);

/// Mutating outbound message kinds persisted in the session outbox.
enum SessionOutboxMessageKind {
  /// User prompt frame.
  prompt,

  /// Slash command frame.
  command,

  /// Capability-advertised action command.
  ///
  /// The current broker classifies every command frame as prompt-class, so
  /// controllers must require prompt permission before sending this kind.
  actionCommand,

  /// Semantic plan approve/revise/exit frame.
  planAction,

  /// Structured sandboxed-artifact interaction frame.
  artifactInteraction,

  /// Permission approve/deny frame.
  permissionDecision,

  /// Question answer frame.
  questionAnswer,

  /// Question dismiss frame.
  rejectQuestion,

  /// Session agent/mode switch frame (`set-agent`).
  setAgent,

  /// Legacy small-file WebSocket frame.
  file,
}

/// Durable outbox lifecycle.
enum SessionOutboxMessageStatus {
  /// Persisted but not yet sent.
  queued,

  /// A transport send was attempted and is awaiting broker ack/nack.
  sending,

  /// The transport failed; the row can replay inside the short retry window.
  retryable,

  /// Broker acked the message.
  delivered,

  /// Broker rejected the message permanently or retry window expired.
  failed,
}

/// Durable mutating session message.
@immutable
class SessionOutboxMessage {
  /// Creates a session outbox message.
  const SessionOutboxMessage({
    required this.sessionKey,
    required this.clientMessageId,
    required this.kind,
    required this.payload,
    required this.status,
    required this.createdAt,
    required this.updatedAt,
    this.brokerProfileId,
    this.attemptCount = 0,
    this.lastError,
  });

  /// Creates a newly queued message.
  factory SessionOutboxMessage.create({
    required SessionDetailKey sessionKey,
    required String clientMessageId,
    required SessionOutboxMessageKind kind,
    required Map<String, dynamic> payload,
    String? brokerProfileId,
  }) {
    final now = DateTime.now();
    return SessionOutboxMessage(
      sessionKey: sessionKey,
      brokerProfileId: brokerProfileId,
      clientMessageId: clientMessageId,
      kind: kind,
      payload: Map.unmodifiable(payload),
      status: SessionOutboxMessageStatus.queued,
      createdAt: now,
      updatedAt: now,
    );
  }

  /// Owning session.
  final SessionDetailKey sessionKey;

  /// Broker profile that owns the session and replay authority.
  ///
  /// Null is reserved for pre-v12 rows and isolated fixtures. Production
  /// replay always supplies an exact profile id, so legacy rows fail closed.
  /// Broker scope key (`RosterSource.storageKey`) of the broker this action
  /// was composed against, or null for a legacy unscoped row. Replay filters
  /// by the CURRENT connection's scope, so a prompt queued against one
  /// machine can never replay into an identically-named session on the
  /// machine the profile was later re-pointed at — and legacy rows (null or
  /// bare profile id) never replay at all.
  final String? brokerProfileId;

  /// Stable broker idempotency key.
  final String clientMessageId;

  /// Outbound frame kind.
  final SessionOutboxMessageKind kind;

  /// Minimal replay payload.
  final Map<String, dynamic> payload;

  /// Outbox lifecycle status.
  final SessionOutboxMessageStatus status;

  /// Send attempts.
  final int attemptCount;

  /// Last error, when any.
  final String? lastError;

  /// Creation timestamp.
  final DateTime createdAt;

  /// Last update timestamp.
  final DateTime updatedAt;

  /// Whether this row is eligible for an automatic replay.
  bool isRetryableAt(DateTime now) {
    if (status != SessionOutboxMessageStatus.queued &&
        status != SessionOutboxMessageStatus.sending &&
        status != SessionOutboxMessageStatus.retryable) {
      return false;
    }
    if (attemptCount >= sessionOutboxMaxAttempts) {
      return false;
    }
    return now.difference(createdAt) <= sessionOutboxRetryWindow;
  }

  /// Returns a copy with optional overrides.
  SessionOutboxMessage copyWith({
    SessionOutboxMessageStatus? status,
    int? attemptCount,
    String? lastError,
    DateTime? updatedAt,
    bool clearError = false,
  }) {
    return SessionOutboxMessage(
      sessionKey: sessionKey,
      brokerProfileId: brokerProfileId,
      clientMessageId: clientMessageId,
      kind: kind,
      payload: payload,
      status: status ?? this.status,
      attemptCount: attemptCount ?? this.attemptCount,
      lastError: clearError ? null : lastError ?? this.lastError,
      createdAt: createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }
}

/// Persistence boundary for the durable session outbox.
abstract interface class SessionOutboxRepository {
  /// Inserts or updates one outbox row.
  Future<void> upsert(SessionOutboxMessage message);

  /// Loads outbox rows for one session, oldest first.
  Future<List<SessionOutboxMessage>> loadForSession(
    SessionDetailKey sessionKey, {
    String? brokerProfileId,
  });

  /// Loads rows eligible for automatic replay.
  Future<List<SessionOutboxMessage>> loadRetryableForSession(
    SessionDetailKey sessionKey, {
    String? brokerProfileId,
    DateTime? now,
  });

  /// Marks a row as sent and awaiting broker ack/nack.
  Future<void> markSending(String clientMessageId);

  /// Marks a row delivered by broker ack.
  Future<void> markDelivered(String clientMessageId);

  /// Marks a row retryable after transport failure or retriable nack.
  Future<void> markRetryable(String clientMessageId, String error);

  /// Marks a row terminally failed.
  Future<void> markFailed(String clientMessageId, String error);

  /// Deletes one row — a failed prompt the user has resolved through the
  /// recovery UI (DR1 retention: resolved failed rows are removed rather than
  /// waiting out the fallback TTL). Idempotent: a missing row is a no-op.
  Future<void> remove(String clientMessageId);
}

/// Drift-backed durable session outbox.
class DriftSessionOutboxRepository implements SessionOutboxRepository {
  /// Creates a repository backed by [database].
  const DriftSessionOutboxRepository(this.database);

  /// App-local durable database.
  final AppDatabase database;

  @override
  Future<void> upsert(SessionOutboxMessage message) async {
    await database
        .into(database.sessionOutboxRows)
        .insertOnConflictUpdate(_toCompanion(message));
  }

  @override
  Future<List<SessionOutboxMessage>> loadForSession(
    SessionDetailKey sessionKey, {
    String? brokerProfileId,
  }) async {
    final rows =
        await (database.select(database.sessionOutboxRows)
              ..where(
                (row) =>
                    row.tool.equals(sessionKey.tool) &
                    row.sessionId.equals(sessionKey.sessionId) &
                    (brokerProfileId == null
                        ? const Constant(true)
                        : row.brokerProfileId.equals(brokerProfileId)),
              )
              ..orderBy([(row) => OrderingTerm.asc(row.createdAt)]))
            .get();
    return rows.map(_fromRow).toList(growable: false);
  }

  @override
  Future<List<SessionOutboxMessage>> loadRetryableForSession(
    SessionDetailKey sessionKey, {
    String? brokerProfileId,
    DateTime? now,
  }) async {
    final clock = now ?? DateTime.now();
    final messages = await loadForSession(
      sessionKey,
      brokerProfileId: brokerProfileId,
    );
    return messages
        .where((message) => message.isRetryableAt(clock))
        .toList(growable: false);
  }

  @override
  Future<void> markSending(String clientMessageId) {
    return _updateStatus(
      clientMessageId,
      status: SessionOutboxMessageStatus.sending,
      incrementAttempt: true,
      clearError: true,
    );
  }

  @override
  Future<void> markDelivered(String clientMessageId) {
    // Broker delivery is terminal: the replay payload is no longer needed for
    // recovery, so it is stripped in the same write (DR1 retention). Late or
    // repeated receipts stay harmless — the row is already terminal.
    return _updateStatus(
      clientMessageId,
      status: SessionOutboxMessageStatus.delivered,
      clearError: true,
      stripPayload: true,
    );
  }

  @override
  Future<void> markRetryable(String clientMessageId, String error) {
    return _updateStatus(
      clientMessageId,
      status: SessionOutboxMessageStatus.retryable,
      lastError: error,
    );
  }

  @override
  Future<void> markFailed(String clientMessageId, String error) {
    return _updateStatus(
      clientMessageId,
      status: SessionOutboxMessageStatus.failed,
      lastError: error,
    );
  }

  @override
  Future<void> remove(String clientMessageId) {
    return (database.delete(
      database.sessionOutboxRows,
    )..where((row) => row.clientMessageId.equals(clientMessageId))).go();
  }

  Future<void> _updateStatus(
    String clientMessageId, {
    required SessionOutboxMessageStatus status,
    bool incrementAttempt = false,
    bool clearError = false,
    bool stripPayload = false,
    String? lastError,
  }) async {
    // ONE conditional statement, not read-then-write. Broker receipts are
    // terminal, and this repository is shared by more than one writer (a
    // second tab, the maintenance pass): a receipt landing between a SELECT
    // and its following UPDATE would be silently regressed back into the
    // replay set. The status predicate makes the terminal guard and the write
    // a single atomic decision; the attempt counter advances in SQL for the
    // same reason.
    final sets = <String>['status = ?', 'updated_at = ?'];
    final variables = <Variable<Object>>[
      Variable.withString(status.name),
      Variable.withInt(DateTime.now().millisecondsSinceEpoch ~/ 1000),
    ];
    if (stripPayload) {
      sets.add("payload_json = '{}'");
    }
    if (incrementAttempt) {
      sets.add('attempt_count = attempt_count + 1');
    }
    if (clearError) {
      sets.add('last_error = NULL');
    } else if (lastError != null) {
      sets.add('last_error = ?');
      variables.add(Variable.withString(lastError));
    }
    variables.add(Variable.withString(clientMessageId));
    await database.customUpdate(
      'UPDATE session_outbox_rows SET ${sets.join(', ')} '
      "WHERE client_message_id = ? AND status NOT IN ('delivered', 'failed')",
      variables: variables,
      updates: {database.sessionOutboxRows},
      updateKind: UpdateKind.update,
    );
  }

  SessionOutboxMessage _fromRow(SessionOutboxRow row) {
    return SessionOutboxMessage(
      sessionKey: SessionDetailKey(
        tool: row.tool,
        sessionId: row.sessionId,
      ),
      brokerProfileId: row.brokerProfileId,
      clientMessageId: row.clientMessageId,
      kind: SessionOutboxMessageKind.values.byName(row.kind),
      payload: Map<String, dynamic>.unmodifiable(
        jsonDecode(row.payloadJson) as Map<String, dynamic>,
      ),
      status: SessionOutboxMessageStatus.values.byName(row.status),
      attemptCount: row.attemptCount,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    );
  }

  SessionOutboxRowsCompanion _toCompanion(SessionOutboxMessage message) {
    return SessionOutboxRowsCompanion.insert(
      clientMessageId: message.clientMessageId,
      brokerProfileId: Value(message.brokerProfileId),
      tool: message.sessionKey.tool,
      sessionId: message.sessionKey.sessionId,
      kind: message.kind.name,
      payloadJson: jsonEncode(message.payload),
      status: message.status.name,
      attemptCount: Value(message.attemptCount),
      lastError: Value(message.lastError),
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    );
  }
}

/// App-level session outbox provider.
final sessionOutboxRepositoryProvider = Provider<SessionOutboxRepository>(
  (ref) => DriftSessionOutboxRepository(ref.watch(appDatabaseProvider)),
);

/// Fire-and-forget helper for provider call sites that update the outbox.
void persistOutbox(Future<void> future) {
  unawaited(future);
}
