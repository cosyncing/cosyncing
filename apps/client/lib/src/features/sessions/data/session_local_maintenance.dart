import 'dart:convert';

import 'package:cosyncing_client/src/features/sessions/data/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_draft_store.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_outbox.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Identity of one profile-scoped session draft row, for reporting which rows
/// a maintenance pass changed under a live controller.
String draftMutationKey({
  required String brokerProfileId,
  required SessionDetailKey sessionKey,
}) => '$brokerProfileId\u0000${sessionKey.tool}\u0000${sessionKey.sessionId}';

/// Outcome of one bounded local-maintenance pass.
@immutable
final class SessionLocalMaintenanceReport {
  /// Creates a report.
  const SessionLocalMaintenanceReport({
    this.expiredOutboxRows = 0,
    this.prunedDeliveredRows = 0,
    this.prunedFailedRows = 0,
    this.prunedDraftRows = 0,
    this.restoredDrafts = 0,
    this.compactedPages = 0,
    this.mutatedDraftKeys = const <String>{},
  });

  /// Live outbox rows that crossed their bounded replay window and were
  /// marked terminally failed (with their prompt text restored to drafts).
  final int expiredOutboxRows;

  /// Delivered outbox shells deleted past their grace period.
  final int prunedDeliveredRows;

  /// Failed outbox rows deleted past their fallback TTL.
  final int prunedFailedRows;

  /// Draft rows deleted by TTL or the per-profile LRU cap.
  final int prunedDraftRows;

  /// Expired prompt rows whose text was restored to a durable draft.
  final int restoredDrafts;

  /// Pages returned by the bounded incremental vacuum (0 when the database
  /// has no incremental auto-vacuum mode or the pass stayed below threshold).
  final int compactedPages;

  /// Draft rows this pass changed, as [draftMutationKey] values.
  ///
  /// Maintenance writes the same rows a live session controller caches, so a
  /// controller showing one of these must drop its cache and reload — the
  /// restored text is often a recovered prompt that has to be OFFERED to the
  /// user, and a banner nobody is told about is text nobody can recover.
  final Set<String> mutatedDraftKeys;

  /// Whether any row changed, so repeated passes can prove forward progress.
  bool get madeProgress =>
      expiredOutboxRows > 0 ||
      prunedDeliveredRows > 0 ||
      prunedFailedRows > 0 ||
      prunedDraftRows > 0;
}

/// Bounded, opportunistic local database maintenance (DR1).
///
/// Retention contract:
/// `2026-07-23-cache-retention-and-continuous-history-paging.md`.
///
/// - Runs only when triggered (session attach, terminal outbox receipt,
///   draft resolution) — never on a timer, never per keystroke.
/// - Every query uses an indexed predicate and a `LIMIT` batch, so one
///   invocation does bounded work regardless of table size.
/// - Deleting rows frees pages for reuse; when enough rows were freed the
///   pass also runs a small `PRAGMA incremental_vacuum` slice. Databases
///   created before incremental auto-vacuum was enabled treat that pragma as
///   a no-op — no automatic full `VACUUM` is ever issued.
final class SessionLocalMaintenance {
  /// Creates maintenance backed by [database].
  SessionLocalMaintenance(this.database)
    : _drafts = DriftSessionDraftRepository(database);

  /// App-local durable database.
  final AppDatabase database;

  /// Draft writes go through the repository's conditional-update contract, so
  /// a maintenance restore advances the same `mutationVersion` every other
  /// writer checks. A raw upsert here would be invisible to a live controller:
  /// its next conditional write could not detect that maintenance changed the
  /// row underneath it.
  final DriftSessionDraftRepository _drafts;

  /// Maximum rows any single step touches per invocation.
  static const int cleanupBatchLimit = 100;

  /// Pages one incremental-vacuum slice may move.
  static const int incrementalVacuumPageBudget = 64;

  /// Freed-row threshold before a pass bothers compacting.
  static const int incrementalVacuumMinFreedRows = 25;

  Future<SessionLocalMaintenanceReport>? _inFlight;

  /// Runs one bounded cleanup pass, coalescing concurrent triggers into the
  /// same in-flight pass.
  Future<SessionLocalMaintenanceReport> runOnce({DateTime? now}) {
    return _inFlight ??= _run(now ?? DateTime.now()).whenComplete(() {
      _inFlight = null;
    });
  }

  Future<SessionLocalMaintenanceReport> _run(DateTime now) async {
    final expired = await _expireLiveOutboxRows(now, cleanupBatchLimit);
    final prunedDelivered = await _deleteRows(
      table: 'session_outbox_rows',
      predicate: "status = 'delivered' AND updated_at < ?",
      cutoff: now.subtract(sessionOutboxDeliveredRetention),
      batchLimit: cleanupBatchLimit,
    );
    final prunedFailed = await _deleteRows(
      table: 'session_outbox_rows',
      predicate: "status = 'failed' AND updated_at < ?",
      cutoff: now.subtract(sessionOutboxFailedRetention),
      batchLimit: cleanupBatchLimit,
    );
    final prunedDrafts = await _pruneDraftRows(now, cleanupBatchLimit);
    final freedRows = prunedDelivered + prunedFailed + prunedDrafts;
    var compactedPages = 0;
    if (freedRows >= incrementalVacuumMinFreedRows) {
      try {
        final vacuumed = await database
            .customSelect(
              'PRAGMA incremental_vacuum($incrementalVacuumPageBudget)',
            )
            .get();
        compactedPages = vacuumed.length;
      } on Object {
        // Databases without incremental auto-vacuum treat the pragma as a
        // no-op; a vacuum failure never fails the cleanup pass.
        compactedPages = 0;
      }
    }
    return SessionLocalMaintenanceReport(
      expiredOutboxRows: expired.expired,
      prunedDeliveredRows: prunedDelivered,
      prunedFailedRows: prunedFailed,
      prunedDraftRows: prunedDrafts,
      restoredDrafts: expired.restored,
      compactedPages: compactedPages,
      mutatedDraftKeys: expired.mutatedDraftKeys,
    );
  }

  /// Marks live outbox rows that can never replay again as terminally failed,
  /// and restores prompt text into the durable draft so nothing is lost.
  ///
  /// Mirrors [SessionOutboxMessage.isRetryableAt]: a queued/sending/retryable
  /// row past its attempts cap or its two-minute window has no replay path
  /// left, so leaving it non-terminal would hide an abandoned failure.
  Future<({int expired, int restored, Set<String> mutatedDraftKeys})>
  _expireLiveOutboxRows(DateTime now, int batchLimit) async {
    final windowCutoff = now.subtract(sessionOutboxRetryWindow);
    final rows = await database
        .customSelect(
          'SELECT client_message_id, broker_profile_id, tool, session_id, '
          'kind, payload_json FROM session_outbox_rows '
          "WHERE status IN ('queued', 'sending', 'retryable') "
          'AND (attempt_count >= ? OR created_at < ?) '
          'ORDER BY created_at ASC LIMIT ?',
          variables: [
            Variable.withInt(sessionOutboxMaxAttempts),
            Variable.withInt(_epochSeconds(windowCutoff)),
            Variable.withInt(batchLimit),
          ],
        )
        .get();
    var expired = 0;
    var restored = 0;
    final mutatedDraftKeys = <String>{};
    for (final row in rows) {
      final clientMessageId = row.read<String>('client_message_id');
      final brokerProfileId = row.read<String?>('broker_profile_id');
      final tool = row.read<String>('tool');
      final sessionId = row.read<String>('session_id');
      final kind = row.read<String>('kind');
      final promptText =
          kind == SessionOutboxMessageKind.prompt.name &&
              brokerProfileId != null
          ? _promptText(row.read<String>('payload_json'))
          : null;
      final outcome = await _expireOneOutboxRow(
        clientMessageId: clientMessageId,
        brokerProfileId: brokerProfileId,
        sessionKey: SessionDetailKey(tool: tool, sessionId: sessionId),
        promptText: promptText,
        now: now,
      );
      if (outcome.expired) expired++;
      if (outcome.restored && brokerProfileId != null) {
        restored++;
        mutatedDraftKeys.add(
          draftMutationKey(
            brokerProfileId: brokerProfileId,
            sessionKey: SessionDetailKey(tool: tool, sessionId: sessionId),
          ),
        );
      }
    }
    return (
      expired: expired,
      restored: restored,
      mutatedDraftKeys: mutatedDraftKeys,
    );
  }

  /// Marks one abandoned outbox row terminally failed and restores its prompt
  /// text into the durable draft — as ONE transaction.
  ///
  /// The mark and the restore stand or fall together. Marked-then-crashed
  /// would leave a failed row this pass never selects again (it only scans
  /// live statuses), stranding the only copy of the text; restored-then-
  /// crashed would leave a live row that replays a prompt the draft already
  /// offers back. A refused restore rolls the mark back too, so the row stays
  /// live and the next pass retries the whole step.
  Future<({bool expired, bool restored})> _expireOneOutboxRow({
    required String clientMessageId,
    required String? brokerProfileId,
    required SessionDetailKey sessionKey,
    required String? promptText,
    required DateTime now,
  }) async {
    try {
      return await database.transaction(() async {
        final claimed = await _claimOutboxRowFailed(
          clientMessageId,
          'Send window expired before the server confirmed delivery.',
        );
        if (claimed == 0) {
          // A broker receipt landed between the candidate SELECT and this
          // claim: the row is delivered (or already terminal) and expiring it
          // now would regress a completed send and "restore" a prompt the
          // agent already ran.
          return (expired: false, restored: false);
        }
        if (brokerProfileId == null ||
            promptText == null ||
            promptText.isEmpty) {
          return (expired: true, restored: false);
        }
        if (promptText.length > maxLocalDraftTextChars) {
          // The draft row refuses oversized text outright; the failed outbox
          // row keeps the payload and remains the recovery copy.
          return (expired: true, restored: false);
        }
        final didRestore = await _restoreDraftForFailedPrompt(
          brokerProfileId: brokerProfileId,
          sessionKey: sessionKey,
          clientMessageId: clientMessageId,
          promptText: promptText,
          now: now,
        );
        return (expired: true, restored: didRestore);
      });
    } on _DraftRestoreRefused {
      return (expired: false, restored: false);
    }
  }

  /// Restores a terminally failed prompt into its session's draft row.
  ///
  /// Never clobbers independent text: when the current row holds different
  /// unsent text under a different association, the failed prompt is preserved
  /// as conflict state instead of replacing that draft.
  ///
  /// Writes use the repository's conditional-update contract; inside the
  /// enclosing transaction the write lock makes a refusal practically
  /// impossible, but the bounded loop keeps this correct even if the
  /// transaction boundary ever changes. Exhaustion throws
  /// [_DraftRestoreRefused] so the enclosing transaction rolls back.
  Future<bool> _restoreDraftForFailedPrompt({
    required String brokerProfileId,
    required SessionDetailKey sessionKey,
    required String clientMessageId,
    required String promptText,
    required DateTime now,
  }) async {
    for (var attempt = 0; attempt < 2; attempt++) {
      final existing = await _drafts.load(
        brokerProfileId: brokerProfileId,
        sessionKey: sessionKey,
      );
      if (existing != null &&
          existing.submittedClientMessageId != clientMessageId &&
          existing.text.isNotEmpty &&
          existing.text != promptText) {
        // Other unsent text owns this row; preserve the failed prompt as
        // conflict state (bounded: one preserved version, resolved by the
        // user). A CLEAN row counts too — it holds another device's adopted
        // shared draft, and overwriting it would republish over that device's
        // unsent text.
        if (existing.conflictText == promptText) return false;
        final stored = await _drafts.save(
          existing.copyWith(conflictText: promptText, updatedAt: now),
        );
        if (stored != null) return true;
        continue;
      }
      final stored = await _drafts.save(
        (existing ??
                SessionLocalDraft.create(
                  brokerProfileId: brokerProfileId,
                  sessionKey: sessionKey,
                  text: promptText,
                ))
            .copyWith(
              text: promptText,
              localRevision: (existing?.localRevision ?? 0) + 1,
              dirty: true,
              clearSubmitted: true,
              // A restored prompt replaces an unfinished post-send clear: the
              // empty pending-clear row exists only to finish the handoff this
              // very prompt just failed.
              clearPendingClear: true,
              clearConflict: true,
              updatedAt: now,
            ),
      );
      if (stored != null) return true;
    }
    throw const _DraftRestoreRefused();
  }

  /// Claims one still-live row as terminally failed, returning how many rows
  /// were claimed (0 or 1).
  ///
  /// Conditional on the row still being live: the expiry candidates were
  /// SELECTed earlier, and a broker receipt can deliver a row in between. An
  /// unconditional update here would overwrite that delivered status.
  Future<int> _claimOutboxRowFailed(String clientMessageId, String error) {
    return (database.update(database.sessionOutboxRows)..where(
          (row) =>
              row.clientMessageId.equals(clientMessageId) &
              row.status.isIn([
                SessionOutboxMessageStatus.queued.name,
                SessionOutboxMessageStatus.sending.name,
                SessionOutboxMessageStatus.retryable.name,
              ]),
        ))
        .write(
          SessionOutboxRowsCompanion(
            status: Value(SessionOutboxMessageStatus.failed.name),
            lastError: Value(error),
            updatedAt: Value(DateTime.now()),
          ),
        );
  }

  /// Deletes up to [batchLimit] rows matching an indexed predicate.
  Future<int> _deleteRows({
    required String table,
    required String predicate,
    required DateTime cutoff,
    required int batchLimit,
  }) {
    return database.customUpdate(
      'DELETE FROM $table WHERE rowid IN ('
      ' SELECT rowid FROM $table WHERE $predicate '
      ' ORDER BY updated_at ASC LIMIT ?)',
      variables: [
        Variable.withInt(_epochSeconds(cutoff)),
        Variable.withInt(batchLimit),
      ],
      updateKind: UpdateKind.delete,
    );
  }

  /// Draft retention: TTL expiry first, then the per-profile LRU cap. Rows
  /// with unresolved conflicts are preserved until these same documented
  /// bounds apply — never by text heuristics.
  Future<int> _pruneDraftRows(DateTime now, int batchLimit) async {
    var pruned = await _deleteRows(
      table: 'session_draft_rows',
      predicate: 'updated_at < ?',
      cutoff: now.subtract(localDraftRetention),
      batchLimit: batchLimit,
    );
    if (pruned >= batchLimit) return pruned;
    // LRU: profiles holding more than the cap lose their oldest rows.
    final overCap = await database
        .customSelect(
          'SELECT broker_profile_id, COUNT(*) AS row_count '
          'FROM session_draft_rows GROUP BY broker_profile_id '
          'HAVING row_count > ?',
          variables: [Variable.withInt(maxRetainedLocalDraftsPerProfile)],
        )
        .get();
    for (final row in overCap) {
      if (pruned >= batchLimit) break;
      final excess =
          row.read<int>('row_count') - maxRetainedLocalDraftsPerProfile;
      final budget = batchLimit - pruned;
      pruned += await database.customUpdate(
        'DELETE FROM session_draft_rows WHERE rowid IN ('
        ' SELECT rowid FROM session_draft_rows WHERE broker_profile_id = ? '
        ' ORDER BY updated_at ASC LIMIT ?)',
        variables: [
          Variable.withString(row.read<String>('broker_profile_id')),
          Variable.withInt(excess < budget ? excess : budget),
        ],
        updateKind: UpdateKind.delete,
      );
    }
    return pruned;
  }

  String? _promptText(String payloadJson) {
    try {
      final payload = jsonDecode(payloadJson);
      if (payload is Map<String, dynamic>) return payload['text'] as String?;
      if (payload is Map) return payload['text'] as String?;
      return null;
    } on Object {
      return null;
    }
  }
}

/// Drift stores `DateTimeColumn` values as unix epoch seconds by default.
int _epochSeconds(DateTime value) => value.millisecondsSinceEpoch ~/ 1000;

/// Raised when a failed-prompt restore lost its conditional write repeatedly;
/// unwinds the expiry transaction so the mark-failed rolls back with it.
final class _DraftRestoreRefused implements Exception {
  const _DraftRestoreRefused();
}

/// Singleton local maintenance runner.
final sessionLocalMaintenanceProvider = Provider<SessionLocalMaintenance>(
  (ref) => SessionLocalMaintenance(ref.watch(appDatabaseProvider)),
);
