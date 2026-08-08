import 'package:cosyncing_client/src/features/sessions/data/session_cache_write_fence.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_detail_state.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Counts removed rebuildable local cache rows.
final class SessionCacheClearReport {
  /// Creates a report.
  const SessionCacheClearReport({
    required this.transcripts,
    required this.rosters,
  });

  /// Deleted bounded transcript snapshots.
  final int transcripts;

  /// Deleted bounded roster identity snapshots.
  final int rosters;
}

/// Explicit deletion boundary for rebuildable session caches.
///
/// Drafts, outbox rows, open-session membership, Drive provenance, settings,
/// transfer ledgers, and attention state are authoritative local state and are
/// intentionally outside this service. Artifact bytes are broker-owned for the
/// current-session action and cleared through its existing authenticated API.
final class SessionCacheManagement {
  /// Creates cache management over the app database.
  SessionCacheManagement(
    this.database, {
    SessionCacheWriteFence? writeFence,
  }) : writeFence = writeFence ?? SessionCacheWriteFence();

  /// Local app database.
  final AppDatabase database;

  /// Shared cache-write admission boundary.
  final SessionCacheWriteFence writeFence;

  /// Removes one exact broker-source/tool/session transcript snapshot.
  Future<int> clearCurrentSession({
    required String brokerSourceKey,
    required SessionDetailKey sessionKey,
  }) => writeFence.clearTranscript(
    brokerSourceKey: brokerSourceKey,
    tool: sessionKey.tool,
    sessionId: sessionKey.sessionId,
    operation: () =>
        (database.delete(database.sessionTranscriptRows)..where(
              (row) =>
                  row.brokerProfileId.equals(brokerSourceKey) &
                  row.tool.equals(sessionKey.tool) &
                  row.sessionId.equals(sessionKey.sessionId),
            ))
            .go(),
  );

  /// Removes every rebuildable transcript and roster snapshot atomically.
  Future<SessionCacheClearReport> clearAll() => writeFence.clearAll(
    () => database.transaction(() async {
      final transcripts = await database
          .delete(database.sessionTranscriptRows)
          .go();
      final rosters = await database.delete(database.rosterSnapshotRows).go();
      return SessionCacheClearReport(
        transcripts: transcripts,
        rosters: rosters,
      );
    }),
  );
}

/// App-wide rebuildable session-cache manager.
final sessionCacheManagementProvider = Provider<SessionCacheManagement>((ref) {
  return SessionCacheManagement(
    ref.watch(appDatabaseProvider),
    writeFence: ref.watch(sessionCacheWriteFenceProvider),
  );
});
