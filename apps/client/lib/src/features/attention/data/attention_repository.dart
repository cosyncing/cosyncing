import 'dart:convert';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart';

/// Durable feed persistence contract for broker attention events.
abstract interface class AttentionRepository {
  /// Persists a full page from `/attention-events`, and updates cursor atomically.
  Future<void> persistAttentionEventsPage({
    required String brokerProfileId,
    required AttentionEventsPage page,
  });

  /// Loads durable rows for one broker profile, newest first.
  Future<List<AttentionEventView>> loadEvents(String brokerProfileId);

  /// Loads event rows with local and broker state for delivery reconciliation.
  Future<List<AttentionDeliveryState>> loadDeliveryStates(
    String brokerProfileId,
  );

  /// Loads event rows with pending local read/dismiss mutations.
  Future<List<AttentionDeliveryState>> loadPendingMutations(
    String brokerProfileId,
  );

  /// Loads event rows waiting for presentation replay.
  Future<List<AttentionDeliveryState>> loadPendingPresentations(
    String brokerProfileId,
  );

  /// Loads durable cursor for one broker profile, or 0 when unknown.
  Future<int> loadCursor(String brokerProfileId);

  /// Local unread count for one broker profile.
  Future<int> loadUnreadCount(String brokerProfileId);

  /// Updates local read timestamp for an event.
  Future<void> markRead(
    String brokerProfileId,
    String eventId, {
    DateTime? readAt,
  });

  /// Updates local dismissed timestamp for an event.
  Future<void> markDismissed(
    String brokerProfileId,
    String eventId, {
    DateTime? dismissedAt,
  });

  /// Dismisses only rows that still match the exact loaded snapshot.
  ///
  /// Every matching row is updated in one database transaction.
  Future<List<AttentionEventSnapshot>> markSnapshotDismissed(
    List<AttentionEventSnapshot> snapshot, {
    DateTime? dismissedAt,
  });

  /// Applies one broker bulk result and releases obsolete stale dismissals.
  ///
  /// Returns the number of stale local dismissals that became visible again.
  Future<int> reconcileBulkDismissResult({
    required String brokerProfileId,
    required AttentionBulkDismissResponse result,
  });

  /// Advances the local presented revision only when
  /// it is higher than stored revision.
  ///
  /// Returns true when the revision advanced.
  Future<bool> advancePresentedRevision({
    required String brokerProfileId,
    required String eventId,
    required int presentedRevision,
  });

  /// Marks broker read state after successful acknowledgement reconciliation.
  Future<bool> markBrokerReadSynced({
    required String brokerProfileId,
    required String eventId,
    required DateTime brokerReadAt,
  });

  /// Marks broker dismiss state after successful dismissal reconciliation.
  Future<bool> markBrokerDismissedSynced({
    required String brokerProfileId,
    required String eventId,
    required DateTime brokerDismissedAt,
  });
}

/// Delivery-state envelope for durable reconciliation and presentation
/// decisions.
final class AttentionDeliveryState {
  /// Creates a delivery-state view.
  const AttentionDeliveryState({
    required this.event,
    required this.localPresentedRevision,
    required this.localReadAt,
    required this.localDismissedAt,
    required this.localDismissedRevision,
    required this.brokerReadAt,
    required this.brokerDismissedAt,
  });

  /// Event view rendered for persistence and presentation logic.
  final AttentionEventView event;

  /// Last presentation revision successfully rendered by this client.
  final int localPresentedRevision;

  /// Client-only read state timestamp.
  final int? localReadAt;

  /// Client-only dismiss state timestamp.
  final int? localDismissedAt;

  /// Exact event revision targeted by a bulk local dismissal.
  final int? localDismissedRevision;

  /// Broker read state timestamp.
  final int? brokerReadAt;

  /// Broker dismiss state timestamp.
  final int? brokerDismissedAt;
}

/// Source-scoped exact event revision from a loaded inbox snapshot.
final class AttentionEventSnapshot {
  /// Creates a source-scoped event revision identity.
  const AttentionEventSnapshot({
    required this.brokerProfileId,
    required this.eventId,
    required this.revision,
  });

  /// Exact durable broker scope.
  ///
  /// The historical field name is retained for repository API compatibility.
  final String brokerProfileId;

  /// Stable broker event id.
  final String eventId;

  /// Exact loaded event revision.
  final int revision;

  /// Wire identity for one source-scoped bulk request.
  AttentionBulkDismissItem get bulkItem =>
      AttentionBulkDismissItem(eventId: eventId, revision: revision);
}

/// Drift-backed durable repository for the attention feed.
class DriftAttentionRepository implements AttentionRepository {
  /// Creates a repository bound to [database].
  const DriftAttentionRepository(this.database);

  /// App-local durable database.
  final AppDatabase database;

  @override
  Future<void> persistAttentionEventsPage({
    required String brokerProfileId,
    required AttentionEventsPage page,
  }) async {
    if (page.cursor < 0) {
      throw ArgumentError('Attention cursor must be non-negative', 'cursor');
    }
    await database.transaction(() async {
      final incomingEvents = List<AttentionEventView>.unmodifiable(page.events);
      final eventIds = {
        for (final event in incomingEvents) event.id,
      };
      final existingRows = await _readExistingRows(
        brokerProfileId: brokerProfileId,
        eventIds: eventIds,
      );
      final currentCursor =
          await (database.select(
                database.attentionCursorRows,
              )..where(
                (row) => row.brokerProfileId.equals(brokerProfileId),
              ))
              .getSingleOrNull();
      // A reset starts a new history epoch; see
      // docs/architecture/client-ui.md
      final baselineThroughCursor = page.reset
          ? page.baselineThroughCursor
          : currentCursor?.baselineThroughCursor ?? page.baselineThroughCursor;
      final shouldPersistBaseline =
          currentCursor?.baselineThroughCursor == null &&
          baselineThroughCursor != null;

      if (page.reset) {
        await (database.delete(
          database.attentionEventRows,
        )..where((row) => row.brokerProfileId.equals(brokerProfileId))).go();
      } else if (shouldPersistBaseline) {
        await _markHistoricalBaselineRows(
          brokerProfileId: brokerProfileId,
          baselineThroughCursor: baselineThroughCursor,
        );
      }

      for (final event in incomingEvents) {
        final existing = existingRows[event.id];
        if (!page.reset &&
            _isStaleIncomingEvent(event: event, existing: existing)) {
          continue;
        }
        await database
            .into(database.attentionEventRows)
            .insert(
              _toCompanion(
                brokerProfileId: brokerProfileId,
                event: event,
                baselineThroughCursor: baselineThroughCursor,
                existing: existing,
              ),
              mode: InsertMode.insertOrReplace,
            );
      }

      var durableCursor = page.cursor;
      if (!page.reset &&
          currentCursor != null &&
          currentCursor.cursor > durableCursor) {
        durableCursor = currentCursor.cursor;
      }

      await database
          .into(database.attentionCursorRows)
          .insertOnConflictUpdate(
            AttentionCursorRowsCompanion.insert(
              brokerProfileId: brokerProfileId,
              cursor: durableCursor,
              baselineThroughCursor: Value(baselineThroughCursor),
              initialSyncComplete: Value(
                page.reset
                    ? !page.hasMore
                    : (currentCursor?.initialSyncComplete ?? false) ||
                          !page.hasMore,
              ),
              persistedAt: DateTime.now(),
            ),
          );
    });
  }

  @override
  Future<List<AttentionEventView>> loadEvents(String brokerProfileId) async {
    final rows =
        await (database.select(database.attentionEventRows)
              ..where((row) => row.brokerProfileId.equals(brokerProfileId))
              ..orderBy([
                (row) => OrderingTerm.desc(row.updatedAt),
                (row) => OrderingTerm.desc(row.cursor),
              ]))
            .get();
    return rows.map(_fromRow).toList(growable: false);
  }

  @override
  Future<List<AttentionDeliveryState>> loadDeliveryStates(
    String brokerProfileId,
  ) async {
    final rows =
        await (database.select(database.attentionEventRows)
              ..where((row) => row.brokerProfileId.equals(brokerProfileId))
              ..orderBy([
                (row) => OrderingTerm.desc(row.updatedAt),
                (row) => OrderingTerm.desc(row.cursor),
              ]))
            .get();
    return rows.map(_toDeliveryState).toList(growable: false);
  }

  @override
  Future<List<AttentionDeliveryState>> loadPendingMutations(
    String brokerProfileId,
  ) async {
    final rows =
        await (database.select(database.attentionEventRows)
              ..where((row) => row.brokerProfileId.equals(brokerProfileId))
              ..where(
                (_) => const CustomExpression<bool>(
                  '(local_read_at IS NOT NULL AND '
                  '(broker_read_at IS NULL OR local_read_at > broker_read_at)) '
                  'OR (local_dismissed_at IS NOT NULL AND '
                  '(broker_dismissed_at IS NULL OR '
                  'local_dismissed_at > broker_dismissed_at))',
                ),
              )
              ..orderBy([
                (row) => OrderingTerm.desc(row.updatedAt),
                (row) => OrderingTerm.desc(row.cursor),
              ]))
            .get();

    return rows
        .map(_toDeliveryState)
        .where(
          (state) =>
              (state.localReadAt != null &&
                  (state.brokerReadAt == null ||
                      state.localReadAt! > state.brokerReadAt!)) ||
              (state.localDismissedAt != null &&
                  (state.brokerDismissedAt == null ||
                      state.localDismissedAt! > state.brokerDismissedAt!)),
        )
        .toList(growable: false);
  }

  @override
  Future<List<AttentionDeliveryState>> loadPendingPresentations(
    String brokerProfileId,
  ) async {
    final rows =
        await (database.select(database.attentionEventRows)
              ..where((row) => row.brokerProfileId.equals(brokerProfileId))
              ..where(
                (_) => const CustomExpression<bool>(
                  'historical_baseline = 0 '
                  'AND local_dismissed_at IS NULL '
                  'AND broker_dismissed_at IS NULL '
                  'AND presentation_revision > local_presented_revision',
                ),
              )
              ..orderBy([
                (row) => OrderingTerm.desc(row.updatedAt),
                (row) => OrderingTerm.desc(row.cursor),
              ]))
            .get();

    return rows.map(_toDeliveryState).toList(growable: false);
  }

  @override
  Future<int> loadCursor(String brokerProfileId) async {
    final cursor =
        await (database.select(database.attentionCursorRows)
              ..where((row) => row.brokerProfileId.equals(brokerProfileId)))
            .getSingleOrNull();
    return cursor?.cursor ?? 0;
  }

  @override
  Future<int> loadUnreadCount(String brokerProfileId) async {
    // Count in SQLite without materializing retained event payloads.
    final unreadExpression = countAll();
    final row =
        await (database.selectOnly(database.attentionEventRows)
              ..addColumns([unreadExpression])
              ..where(
                database.attentionEventRows.brokerProfileId.equals(
                  brokerProfileId,
                ),
              )
              ..where(
                database.attentionEventRows.localReadAt.isNull() &
                    database.attentionEventRows.brokerReadAt.isNull(),
              )
              ..where(
                database.attentionEventRows.localDismissedAt.isNull() &
                    database.attentionEventRows.brokerDismissedAt.isNull(),
              )
              ..where(
                database.attentionEventRows.historicalBaseline.equals(false),
              ))
            .getSingle();

    return row.read(unreadExpression) ?? 0;
  }

  @override
  Future<void> markRead(
    String brokerProfileId,
    String eventId, {
    DateTime? readAt,
  }) async {
    await _updateLocalTimestamp(
      brokerProfileId: brokerProfileId,
      eventId: eventId,
      columnValue: readAt,
      value: (ts) => AttentionEventRowsCompanion(
        localReadAt: Value(ts?.millisecondsSinceEpoch),
      ),
    );
  }

  @override
  Future<void> markDismissed(
    String brokerProfileId,
    String eventId, {
    DateTime? dismissedAt,
  }) async {
    await _updateLocalTimestamp(
      brokerProfileId: brokerProfileId,
      eventId: eventId,
      columnValue: dismissedAt,
      value: (ts) => AttentionEventRowsCompanion(
        localDismissedAt: Value(ts?.millisecondsSinceEpoch),
      ),
    );
  }

  @override
  Future<List<AttentionEventSnapshot>> markSnapshotDismissed(
    List<AttentionEventSnapshot> snapshot, {
    DateTime? dismissedAt,
  }) async {
    if (snapshot.isEmpty) return const [];
    final timestamp = (dismissedAt ?? DateTime.now()).millisecondsSinceEpoch;
    final accepted = <AttentionEventSnapshot>[];
    await database.transaction(() async {
      for (final item in snapshot) {
        final updated =
            await (database.update(database.attentionEventRows)..where(
                  (row) =>
                      row.brokerProfileId.equals(item.brokerProfileId) &
                      row.eventId.equals(item.eventId) &
                      row.revision.equals(item.revision) &
                      row.localDismissedAt.isNull(),
                ))
                .write(
                  AttentionEventRowsCompanion(
                    localDismissedAt: Value(timestamp),
                    localDismissedRevision: Value(item.revision),
                    persistedAt: Value(DateTime.now()),
                  ),
                );
        if (updated > 0) accepted.add(item);
      }
    });
    return List.unmodifiable(accepted);
  }

  @override
  Future<int> reconcileBulkDismissResult({
    required String brokerProfileId,
    required AttentionBulkDismissResponse result,
  }) async {
    var releasedStale = 0;
    await database.transaction(() async {
      for (final accepted in result.accepted) {
        final row =
            await (database.select(database.attentionEventRows)..where(
                  (candidate) =>
                      candidate.brokerProfileId.equals(brokerProfileId) &
                      candidate.eventId.equals(accepted.eventId) &
                      candidate.localDismissedRevision.equals(
                        accepted.revision,
                      ),
                ))
                .getSingleOrNull();
        if (row?.localDismissedAt == null) continue;
        await (database.update(database.attentionEventRows)..where(
              (row) =>
                  row.brokerProfileId.equals(brokerProfileId) &
                  row.eventId.equals(accepted.eventId) &
                  row.localDismissedRevision.equals(accepted.revision),
            ))
            .write(
              AttentionEventRowsCompanion(
                // A structured accepted result is authoritative even when the
                // client clock is ahead of the broker clock.
                brokerDismissedAt: Value(
                  accepted.dismissedAt > row!.localDismissedAt!
                      ? accepted.dismissedAt
                      : row.localDismissedAt,
                ),
                persistedAt: Value(DateTime.now()),
              ),
            );
      }
      for (final stale in result.stale) {
        releasedStale +=
            await (database.update(database.attentionEventRows)..where(
                  (row) =>
                      row.brokerProfileId.equals(brokerProfileId) &
                      row.eventId.equals(stale.eventId) &
                      row.localDismissedRevision.equals(stale.revision),
                ))
                .write(
                  AttentionEventRowsCompanion(
                    brokerDismissedAt: const Value(null),
                    localDismissedAt: const Value(null),
                    localDismissedRevision: const Value(null),
                    persistedAt: Value(DateTime.now()),
                  ),
                );
      }
      // A pruned broker record cannot be retried. Keep the user's local
      // dismissal and retire its pending mutation.
      for (final missing in result.notFound) {
        final row =
            await (database.select(database.attentionEventRows)..where(
                  (candidate) =>
                      candidate.brokerProfileId.equals(brokerProfileId) &
                      candidate.eventId.equals(missing.eventId) &
                      candidate.localDismissedRevision.equals(missing.revision),
                ))
                .getSingleOrNull();
        if (row?.localDismissedAt == null) continue;
        await (database.update(database.attentionEventRows)..where(
              (candidate) =>
                  candidate.brokerProfileId.equals(brokerProfileId) &
                  candidate.eventId.equals(missing.eventId),
            ))
            .write(
              AttentionEventRowsCompanion(
                brokerDismissedAt: Value(row!.localDismissedAt),
                persistedAt: Value(DateTime.now()),
              ),
            );
      }
    });
    return releasedStale;
  }

  @override
  Future<bool> advancePresentedRevision({
    required String brokerProfileId,
    required String eventId,
    required int presentedRevision,
  }) async {
    final updated =
        await (database.update(database.attentionEventRows)..where(
              (row) =>
                  row.brokerProfileId.equals(brokerProfileId) &
                  row.eventId.equals(eventId) &
                  row.localPresentedRevision.isSmallerThanValue(
                    presentedRevision,
                  ),
            ))
            .write(
              AttentionEventRowsCompanion(
                localPresentedRevision: Value(presentedRevision),
                persistedAt: Value(DateTime.now()),
              ),
            );

    return updated > 0;
  }

  @override
  Future<bool> markBrokerReadSynced({
    required String brokerProfileId,
    required String eventId,
    required DateTime brokerReadAt,
  }) async {
    final updated =
        await (database.update(database.attentionEventRows)..where(
              (row) =>
                  row.brokerProfileId.equals(brokerProfileId) &
                  row.eventId.equals(eventId),
            ))
            .write(
              AttentionEventRowsCompanion(
                brokerReadAt: Value(brokerReadAt.millisecondsSinceEpoch),
                persistedAt: Value(DateTime.now()),
              ),
            );
    return updated > 0;
  }

  @override
  Future<bool> markBrokerDismissedSynced({
    required String brokerProfileId,
    required String eventId,
    required DateTime brokerDismissedAt,
  }) async {
    final updated =
        await (database.update(database.attentionEventRows)..where(
              (row) =>
                  row.brokerProfileId.equals(brokerProfileId) &
                  row.eventId.equals(eventId),
            ))
            .write(
              AttentionEventRowsCompanion(
                brokerDismissedAt: Value(
                  brokerDismissedAt.millisecondsSinceEpoch,
                ),
                persistedAt: Value(DateTime.now()),
              ),
            );
    return updated > 0;
  }

  Future<Map<String, AttentionEventRow>> _readExistingRows({
    required String brokerProfileId,
    required Set<String> eventIds,
  }) async {
    if (eventIds.isEmpty) {
      return const {};
    }

    final rows =
        await (database.select(database.attentionEventRows)
              ..where((row) => row.brokerProfileId.equals(brokerProfileId))
              ..where((row) => row.eventId.isIn(eventIds)))
            .get();

    return {
      for (final row in rows) row.eventId: row,
    };
  }

  Future<void> _updateLocalTimestamp({
    required String brokerProfileId,
    required String eventId,
    required DateTime? columnValue,
    required AttentionEventRowsCompanion Function(DateTime? timestamp) value,
  }) async {
    final timestamp = columnValue ?? DateTime.now();
    await (database.update(database.attentionEventRows)..where(
          (row) =>
              row.brokerProfileId.equals(brokerProfileId) &
              row.eventId.equals(eventId),
        ))
        .write(value(timestamp));
  }

  AttentionEventRowsCompanion _toCompanion({
    required String brokerProfileId,
    required AttentionEventView event,
    required int? baselineThroughCursor,
    AttentionEventRow? existing,
  }) {
    final existingLocal = existing;
    final shouldBeHistorical =
        baselineThroughCursor != null && event.cursor <= baselineThroughCursor;

    return AttentionEventRowsCompanion(
      brokerProfileId: Value(brokerProfileId),
      eventId: Value(event.id),
      cursor: Value(event.cursor),
      revision: Value(event.revision),
      presentationRevision: Value(event.presentationRevision),
      presentationStage: Value(event.presentationStage),
      kind: Value(event.kind),
      state: Value(event.state),
      severity: Value(event.severity),
      dedupeKey: Value(event.dedupeKey),
      title: Value(event.title),
      summary: Value(event.summary),
      sessionId: Value(event.sessionId),
      sessionTitle: Value(event.sessionTitle),
      requestId: Value(event.requestId),
      turnId: Value(event.turnId),
      goalKey: Value(event.goalKey),
      agent: Value(event.agent),
      actionKind: Value(event.action.kind),
      actionTool: Value(event.action.tool),
      actionSessionId: Value(event.action.sessionId),
      actionAgent: Value(event.action.agent),
      brokerReadAt: Value(event.readAt),
      brokerDismissedAt: Value(event.dismissedAt),
      createdAt: Value(event.createdAt),
      updatedAt: Value(event.updatedAt),
      resolvedAt: Value(event.resolvedAt),
      localReadAt: Value(existingLocal?.localReadAt),
      localDismissedAt: Value(
        existingLocal?.localDismissedRevision == null ||
                existingLocal?.localDismissedRevision == event.revision
            ? existingLocal?.localDismissedAt
            : null,
      ),
      localDismissedRevision: Value(
        existingLocal?.localDismissedRevision == event.revision
            ? existingLocal?.localDismissedRevision
            : null,
      ),
      localPresentedRevision: Value(
        existingLocal?.localPresentedRevision ?? 0,
      ),
      historicalBaseline: Value(
        shouldBeHistorical,
      ),
      rawEventJson: Value(jsonEncode(event.toJson())),
      persistedAt: Value(DateTime.now()),
    );
  }

  AttentionDeliveryState _toDeliveryState(AttentionEventRow row) {
    return AttentionDeliveryState(
      event: _fromRow(row),
      localPresentedRevision: row.localPresentedRevision,
      localReadAt: row.localReadAt,
      localDismissedAt: row.localDismissedAt,
      localDismissedRevision: row.localDismissedRevision,
      brokerReadAt: row.brokerReadAt,
      brokerDismissedAt: row.brokerDismissedAt,
    );
  }

  bool _isStaleIncomingEvent({
    required AttentionEventView event,
    required AttentionEventRow? existing,
  }) {
    if (existing == null) {
      return false;
    }

    return event.cursor < existing.cursor ||
        event.revision < existing.revision ||
        event.presentationRevision < existing.presentationRevision;
  }

  AttentionEventView _fromRow(AttentionEventRow row) {
    final brokerEvent = AttentionEventView.fromJson(
      jsonDecode(row.rawEventJson) as Map<String, dynamic>,
    );

    return AttentionEventView(
      id: row.eventId,
      cursor: row.cursor,
      revision: row.revision,
      presentationRevision: row.presentationRevision,
      presentationStage: row.presentationStage,
      kind: row.kind,
      state: row.state,
      severity: row.severity,
      dedupeKey: row.dedupeKey,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      resolvedAt: row.resolvedAt,
      agent: row.agent,
      sessionId: row.sessionId,
      sessionTitle: row.sessionTitle,
      requestId: row.requestId,
      turnId: row.turnId,
      goalKey: row.goalKey,
      title: row.title,
      summary: row.summary,
      action: brokerEvent.action,
      readAt: _mergeReadOrDismiss(
        row.brokerReadAt,
        row.localReadAt,
      ),
      dismissedAt: _mergeReadOrDismiss(
        row.brokerDismissedAt,
        row.localDismissedAt,
      ),
      historicalBaseline: row.historicalBaseline,
      raw: brokerEvent.raw,
    );
  }

  static int? _mergeReadOrDismiss(int? brokerValue, int? localValue) {
    if (brokerValue == null) {
      return localValue;
    }
    if (localValue == null) {
      return brokerValue;
    }
    return localValue > brokerValue ? localValue : brokerValue;
  }

  Future<void> _markHistoricalBaselineRows({
    required String brokerProfileId,
    required int baselineThroughCursor,
  }) async {
    final rows = await (database.select(
      database.attentionEventRows,
    )..where((row) => row.brokerProfileId.equals(brokerProfileId))).get();
    for (final row in rows) {
      if (row.historicalBaseline || row.cursor > baselineThroughCursor) {
        continue;
      }
      await (database.update(database.attentionEventRows)..where(
            (tbl) =>
                tbl.brokerProfileId.equals(brokerProfileId) &
                tbl.eventId.equals(row.eventId),
          ))
          .write(
            const AttentionEventRowsCompanion(
              historicalBaseline: Value(true),
            ),
          );
    }
  }
}
