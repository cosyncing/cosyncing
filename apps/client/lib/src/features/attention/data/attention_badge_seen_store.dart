import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart';

const String _badgeSeenCursorPrefix = 'attention_badge_seen_cursor:';

/// Durable, profile-scoped state for the global attention badge.
///
/// This is deliberately separate from event read/dismiss state: successfully
/// opening the inbox clears the navigation badge without resolving any action.
abstract interface class AttentionBadgeSeenStore {
  /// Counts visible events received after the last successful inbox open.
  Future<int> loadUnseenCount(String brokerProfileId);

  /// Last broker cursor successfully rendered by the inbox for this profile.
  Future<int> loadSeenThroughCursor(String brokerProfileId);

  /// Advances the seen watermark monotonically and reports durable change.
  Future<bool> markSeenThroughCursor(String brokerProfileId, int cursor);
}

/// Drift-backed [AttentionBadgeSeenStore].
class DriftAttentionBadgeSeenStore implements AttentionBadgeSeenStore {
  /// Creates a badge store backed by the shared app database.
  const DriftAttentionBadgeSeenStore(this.database);

  /// Shared app database.
  final AppDatabase database;

  /// Counts visible events received after the last successful inbox open.
  @override
  Future<int> loadUnseenCount(String brokerProfileId) async {
    final persistedSeenThrough = await loadSeenThroughCursor(brokerProfileId);
    final feedCursor = await _loadFeedCursor(brokerProfileId);
    // A broker feed reset can start a new cursor epoch below the watermark
    // stored for the prior broker history. Its baseline is already born seen;
    // arrivals after that baseline must still light the badge immediately.
    final seenThrough =
        feedCursor != null && persistedSeenThrough > feedCursor.cursor
        ? feedCursor.baselineThroughCursor ?? 0
        : persistedSeenThrough;
    final countExpression = countAll();
    final row =
        await (database.selectOnly(database.attentionEventRows)
              ..addColumns([countExpression])
              ..where(
                database.attentionEventRows.brokerProfileId.equals(
                  brokerProfileId,
                ),
              )
              ..where(
                database.attentionEventRows.cursor.isBiggerThanValue(
                  seenThrough,
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
    return row.read(countExpression) ?? 0;
  }

  /// Last broker cursor successfully rendered by the inbox for this profile.
  @override
  Future<int> loadSeenThroughCursor(String brokerProfileId) async {
    final row =
        await (database.select(database.appSettingRows)..where(
              (table) => table.key.equals(_key(brokerProfileId)),
            ))
            .getSingleOrNull();
    return int.tryParse(row?.value ?? '') ?? 0;
  }

  /// Advances the seen watermark monotonically.
  ///
  /// Returns whether durable state changed.
  @override
  Future<bool> markSeenThroughCursor(
    String brokerProfileId,
    int cursor,
  ) {
    if (cursor <= 0) return Future.value(false);
    return database.transaction(() async {
      final prior = await loadSeenThroughCursor(brokerProfileId);
      final feedCursor = await _loadFeedCursor(brokerProfileId);
      final resetEpoch = feedCursor != null && prior > feedCursor.cursor;
      if (!resetEpoch && prior >= cursor) return false;
      await database
          .into(database.appSettingRows)
          .insertOnConflictUpdate(
            AppSettingRowsCompanion.insert(
              key: _key(brokerProfileId),
              value: '$cursor',
              updatedAt: DateTime.now(),
            ),
          );
      return true;
    });
  }

  String _key(String brokerProfileId) =>
      '$_badgeSeenCursorPrefix${Uri.encodeComponent(brokerProfileId)}';

  Future<AttentionCursorRow?> _loadFeedCursor(String brokerProfileId) {
    return (database.select(database.attentionCursorRows)..where(
          (row) => row.brokerProfileId.equals(brokerProfileId),
        ))
        .getSingleOrNull();
  }
}
