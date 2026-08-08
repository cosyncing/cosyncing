// Compatibility layer for Drift database ownership moved into
// `broker_client_flutter`.
//
// Existing app imports can continue to use this path while the schema and
// generated types are now owned by the package.
import 'package:broker_client_flutter/broker_client_flutter.dart'
    show AppDatabase;
import 'package:flutter_riverpod/flutter_riverpod.dart';

export 'package:broker_client_flutter/broker_client_flutter.dart'
    show
        AppDatabase,
        AppSettingRow,
        AppSettingRows,
        AppSettingRowsCompanion,
        ArtifactTransferRow,
        ArtifactTransferRows,
        ArtifactTransferRowsCompanion,
        AttentionCursorRow,
        AttentionCursorRows,
        AttentionCursorRowsCompanion,
        AttentionEventRow,
        AttentionEventRows,
        AttentionEventRowsCompanion,
        BrokerProfileRow,
        BrokerProfileRows,
        BrokerProfileRowsCompanion,
        RosterSnapshotRow,
        RosterSnapshotRows,
        RosterSnapshotRowsCompanion,
        SessionDraftRow,
        SessionDraftRows,
        SessionDraftRowsCompanion,
        SessionOutboxRow,
        SessionOutboxRows,
        SessionOutboxRowsCompanion,
        SessionTranscriptRow,
        SessionTranscriptRows,
        SessionTranscriptRowsCompanion;

/// Provider for the app-local durable database.
final appDatabaseProvider = Provider<AppDatabase>((ref) {
  final database = AppDatabase.defaults();
  ref.onDispose(database.close);
  return database;
});
