import 'dart:io';

import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart' hide isNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

/// DR1 migration: a database written at schema v12 keeps its outbox and
/// transcript rows when opened by the current schema, gains the draft table and
/// cleanup indexes, and stays usable; a database already at v13 gains the
/// conditional pending-clear column without losing its drafts. Also proves a
/// file-backed database survives a full close/reopen (the native process-death
/// path).
void main() {
  late Directory tempDir;

  setUp(() async {
    tempDir = await Directory.systemTemp.createTemp('dr1-migration');
  });

  tearDown(() async {
    await tempDir.delete(recursive: true);
  });

  test(
    'v12 preserves useful data and adds bounded-draft storage',
    () async {
      final file = File('${tempDir.path}/client.sqlite');

      // Write a v12-shaped database: the outbox and transcript tables as they
      // existed at schema 12, with one row each and no draft table.
      final legacy = _LegacyV12Database(NativeDatabase(file));
      await legacy.customSelect('SELECT 1').get(); // force open + onCreate
      await legacy.close();

      // Reopen with the current schema: the v13 migration runs.
      final database = AppDatabase(NativeDatabase(file));
      addTearDown(database.close);

      final version = await database
          .customSelect('PRAGMA user_version')
          .getSingle();
      expect(version.read<int>('user_version'), 19);

      // The pre-existing outbox row survives untouched.
      final outboxRows = await database
          .customSelect(
            'SELECT client_message_id, payload_json, status '
            'FROM session_outbox_rows',
          )
          .get();
      expect(outboxRows, hasLength(1));
      expect(outboxRows.single.read<String>('client_message_id'), 'cm-legacy');
      expect(
        outboxRows.single.read<String>('payload_json'),
        contains('legacy prompt'),
      );

      // The pre-existing transcript snapshot survives untouched.
      final transcriptRows = await database
          .customSelect(
            'SELECT session_id, messages_json FROM session_transcript_rows',
          )
          .get();
      expect(transcriptRows, hasLength(1));
      expect(
        transcriptRows.single.read<String>('messages_json'),
        contains('legacy answer'),
      );

      // The draft table and cleanup indexes now exist.
      final objects = await database
          .customSelect(
            "SELECT name, type FROM sqlite_master WHERE name LIKE '%draft%' "
            "OR name LIKE 'idx_session_%'",
          )
          .get();
      final names = objects.map((row) => row.read<String>('name')).toSet();
      expect(names, contains('session_draft_rows'));
      expect(names, contains('idx_session_draft_profile_updated'));
      expect(names, contains('idx_session_outbox_status_updated'));
      expect(names, contains('idx_session_transcript_profile_updated'));

      // And the migrated database is fully usable for drafts.
      await database
          .into(database.sessionDraftRows)
          .insertOnConflictUpdate(
            SessionDraftRowsCompanion.insert(
              brokerProfileId: 'local',
              tool: 'codex',
              sessionId: 'session-1',
              draftText: 'post-migration draft',
              updatedAt: DateTime.utc(2026, 7, 24),
            ),
          );
      final drafts = await database.select(database.sessionDraftRows).get();
      expect(drafts.single.draftText, 'post-migration draft');
    },
  );

  test('v13 gains pending-clear and row-version state', () async {
    final file = File('${tempDir.path}/client-v13.sqlite');

    // A v13 database: the draft table as DR1 first shipped it, with one row.
    final legacy = _LegacyV13Database(NativeDatabase(file));
    await legacy.customSelect('SELECT 1').get();
    await legacy.close();

    final database = AppDatabase(NativeDatabase(file));
    addTearDown(database.close);

    final version = await database
        .customSelect('PRAGMA user_version')
        .getSingle();
    expect(version.read<int>('user_version'), 19);

    // The pre-existing draft survives, and its clear target reads as absent —
    // a v13 row was never a pending clear.
    final row = await database.select(database.sessionDraftRows).getSingle();
    expect(row.draftText, 'draft written at v13');
    expect(row.pendingClearRevision, null);
    expect(row.mutationVersion, 0);

    // And a pending clear can now be recorded.
    await database
        .into(database.sessionDraftRows)
        .insertOnConflictUpdate(
          SessionDraftRowsCompanion.insert(
            brokerProfileId: 'local',
            tool: 'codex',
            sessionId: 'session-1',
            draftText: '',
            pendingClearRevision: const Value(9),
            updatedAt: DateTime.utc(2026, 7, 24),
          ),
        );
    final updated = await database
        .select(database.sessionDraftRows)
        .getSingle();
    expect(updated.pendingClearRevision, 9);
  });

  test('v15 preserves attention rows and adds F4b snapshot columns', () async {
    final file = File('${tempDir.path}/client-v15.sqlite');
    final legacy = _LegacyV15Database(NativeDatabase(file));
    await legacy.customSelect('SELECT 1').get();
    await legacy.close();

    final database = AppDatabase(NativeDatabase(file));
    addTearDown(database.close);

    final version = await database
        .customSelect('PRAGMA user_version')
        .getSingle();
    expect(version.read<int>('user_version'), 19);

    final row = await database.select(database.attentionEventRows).getSingle();
    expect(row.eventId, 'event-v15');
    expect(row.title, 'Legacy attention');
    expect(row.sessionTitle, isNull);
    expect(row.localDismissedRevision, isNull);
    expect(row.rawEventJson, contains('futureField'));

    await (database.update(database.attentionEventRows)..where(
          (candidate) => candidate.eventId.equals('event-v15'),
        ))
        .write(
          const AttentionEventRowsCompanion(
            sessionTitle: Value('Named after migration'),
            localDismissedRevision: Value(3),
          ),
        );
    final updated = await database
        .select(database.attentionEventRows)
        .getSingle();
    expect(updated.sessionTitle, 'Named after migration');
    expect(updated.localDismissedRevision, 3);
  });

  test(
    'v16 preserves every durable row and adds N3 roster snapshots',
    () async {
      final file = File('${tempDir.path}/client-v16.sqlite');

      // A real file-backed v16 database with one row in each durable table the
      // app depends on across restarts.
      final legacy = _LegacyV16Database(NativeDatabase(file));
      await legacy.customSelect('SELECT 1').get();
      await legacy.close();

      final database = AppDatabase(NativeDatabase(file));
      addTearDown(database.close);

      final version = await database
          .customSelect('PRAGMA user_version')
          .getSingle();
      expect(version.read<int>('user_version'), 19);

      // Profiles.
      final profile = await database
          .select(database.brokerProfileRows)
          .getSingle();
      expect(profile.id, 'https://broker.example/');
      expect(profile.displayName, 'Workstation');
      expect(profile.credentialKey, 'cred-v16');
      expect(
        profile.incarnationId,
        startsWith('legacy-'),
        reason:
            'an upgraded saved profile receives a stable authority generation',
      );

      // Attention rows, including the F4b columns added at v16.
      final attention = await database
          .select(database.attentionEventRows)
          .getSingle();
      final attentionScope =
          '${Uri.encodeComponent(profile.id)}@'
          '${Uri.encodeComponent('https://broker.example:7734')}#'
          '${Uri.encodeComponent(profile.incarnationId!)}';
      expect(attention.brokerProfileId, attentionScope);
      expect(attention.eventId, 'event-v16');
      expect(attention.sessionTitle, 'Attention session');
      expect(attention.localDismissedRevision, 4);
      expect(attention.rawEventJson, contains('futureField'));

      final cursor = await database
          .select(database.attentionCursorRows)
          .getSingle();
      expect(cursor.brokerProfileId, attentionScope);
      expect(cursor.cursor, 42);
      expect(cursor.initialSyncComplete, isTrue);

      // Drafts, with their DR1 conflict/version state intact.
      final draft = await database
          .select(database.sessionDraftRows)
          .getSingle();
      expect(draft.draftText, 'draft written at v16');
      expect(draft.mutationVersion, 7);
      expect(draft.pendingClearRevision, 5);
      expect(draft.conflictText, 'shared version');

      // Outbox.
      final outbox = await database
          .select(database.sessionOutboxRows)
          .getSingle();
      expect(outbox.clientMessageId, 'cm-v16');
      expect(outbox.payloadJson, contains('v16 prompt'));
      expect(outbox.status, 'queued');

      // Transcripts.
      final transcript = await database
          .select(database.sessionTranscriptRows)
          .getSingle();
      expect(transcript.messagesJson, contains('v16 answer'));
      expect(transcript.hasEarlier, isTrue);
      expect(transcript.olderCursor, 'cursor-older');

      // App settings (this is where the active broker profile id lives).
      final setting = await database
          .select(database.appSettingRows)
          .getSingle();
      expect(setting.key, 'active_broker_profile_id');
      expect(setting.value, 'https://broker.example/');

      // Artifact transfers.
      final transfer = await database
          .select(database.artifactTransferRows)
          .getSingle();
      expect(transfer.id, 'transfer-v16');
      expect(transfer.fileName, 'report.pdf');

      // The new table exists, starts empty, and is immediately usable.
      final snapshots = await database
          .select(database.rosterSnapshotRows)
          .get();
      expect(snapshots, isEmpty);

      await database
          .into(database.rosterSnapshotRows)
          .insertOnConflictUpdate(
            RosterSnapshotRowsCompanion.insert(
              brokerProfileId: 'https://broker.example/',
              endpoint: 'https://broker.example:8787',
              payloadVersion: 1,
              rowsJson: '[{"tool":"codex","id":"s1"}]',
              rowCount: const Value(1),
              capturedAt: DateTime.utc(2026, 7, 27),
            ),
          );
      final stored = await database
          .select(database.rosterSnapshotRows)
          .getSingle();
      expect(stored.brokerProfileId, 'https://broker.example/');
      expect(stored.endpoint, 'https://broker.example:8787');
      expect(stored.rowsJson, contains('"s1"'));

      // The DR1 cleanup indexes survive the upgrade.
      final objects = await database
          .customSelect(
            "SELECT name FROM sqlite_master WHERE type = 'index' "
            "AND name LIKE 'idx_session_%'",
          )
          .get();
      final indexNames = objects.map((row) => row.read<String>('name')).toSet();
      expect(indexNames, contains('idx_session_draft_profile_updated'));
      expect(indexNames, contains('idx_session_outbox_status_updated'));
      expect(indexNames, contains('idx_session_transcript_profile_updated'));
    },
  );
}

/// The complete schema at v16 — the state of the database before N3 — with one
/// row in every durable table the app relies on across restarts.
final class _LegacyV16Database extends GeneratedDatabase {
  _LegacyV16Database(super.executor);

  @override
  int get schemaVersion => 16;

  @override
  Iterable<TableInfo<Table, Object?>> get allTables => const [];

  @override
  MigrationStrategy get migration => MigrationStrategy(
    onCreate: (_) async {
      await customStatement(
        'CREATE TABLE "broker_profile_rows" ("id" TEXT NOT NULL, '
        '"display_name" TEXT NOT NULL, "base_uri" TEXT NOT NULL, '
        '"created_at" INTEGER NOT NULL, "updated_at" INTEGER NULL, '
        '"last_used_at" INTEGER NULL, "credential_key" TEXT NULL, '
        'PRIMARY KEY ("id"))',
      );
      await customStatement(
        'CREATE TABLE "app_setting_rows" ("key" TEXT NOT NULL, '
        '"value" TEXT NOT NULL, "updated_at" INTEGER NOT NULL, '
        'PRIMARY KEY ("key"))',
      );
      await customStatement(
        'CREATE TABLE "artifact_transfer_rows" ("id" TEXT NOT NULL, '
        '"broker_profile_id" TEXT NULL, "tool" TEXT NOT NULL, '
        '"session_id" TEXT NOT NULL, "action_key" TEXT NOT NULL, '
        '"file_name" TEXT NOT NULL, "direction" TEXT NOT NULL, '
        '"status" TEXT NOT NULL, "attempt_count" INTEGER NOT NULL DEFAULT 0, '
        '"artifact_key" TEXT NULL, "source_url" TEXT NULL, '
        '"cached_file_path" TEXT NULL, "exported_path" TEXT NULL, '
        '"content_type" TEXT NULL, "content_hash" TEXT NULL, '
        '"upload_id" TEXT NULL, "partial_file_path" TEXT NULL, '
        '"download_etag" TEXT NULL, "download_last_modified" TEXT NULL, '
        '"byte_length" INTEGER NULL, "bytes_transferred" INTEGER NULL, '
        '"total_bytes" INTEGER NULL, "error" TEXT NULL, '
        '"message" TEXT NOT NULL DEFAULT \'\', "created_at" INTEGER NOT NULL, '
        '"updated_at" INTEGER NOT NULL, PRIMARY KEY ("id"))',
      );
      await customStatement(
        'CREATE TABLE "attention_event_rows" '
        '("broker_profile_id" TEXT NOT NULL, "event_id" TEXT NOT NULL, '
        '"cursor" INTEGER NOT NULL, "revision" INTEGER NOT NULL, '
        '"presentation_revision" INTEGER NOT NULL, '
        '"presentation_stage" TEXT NULL, "kind" TEXT NOT NULL, '
        '"state" TEXT NOT NULL, "severity" TEXT NOT NULL, '
        '"dedupe_key" TEXT NOT NULL, "title" TEXT NOT NULL, '
        '"summary" TEXT NULL, "session_id" TEXT NULL, '
        '"session_title" TEXT NULL, "request_id" TEXT NULL, '
        '"turn_id" TEXT NULL, "goal_key" TEXT NULL, "agent" TEXT NULL, '
        '"action_kind" TEXT NULL, "action_tool" TEXT NULL, '
        '"action_session_id" TEXT NULL, "action_agent" TEXT NULL, '
        '"broker_read_at" INTEGER NULL, '
        '"historical_baseline" INTEGER NOT NULL DEFAULT 0, '
        '"broker_dismissed_at" INTEGER NULL, "created_at" INTEGER NOT NULL, '
        '"updated_at" INTEGER NOT NULL, "resolved_at" INTEGER NULL, '
        '"local_read_at" INTEGER NULL, "local_dismissed_at" INTEGER NULL, '
        '"local_dismissed_revision" INTEGER NULL, '
        '"local_presented_revision" INTEGER NOT NULL DEFAULT 0, '
        '"raw_event_json" TEXT NOT NULL, "persisted_at" INTEGER NOT NULL, '
        'PRIMARY KEY ("broker_profile_id", "event_id"))',
      );
      await customStatement(
        'CREATE TABLE "attention_cursor_rows" '
        '("broker_profile_id" TEXT NOT NULL, "cursor" INTEGER NOT NULL, '
        '"baseline_through_cursor" INTEGER NULL, '
        '"initial_sync_complete" INTEGER NOT NULL DEFAULT 0, '
        '"persisted_at" INTEGER NOT NULL, PRIMARY KEY ("broker_profile_id"))',
      );
      await customStatement(
        'CREATE TABLE "session_outbox_rows" '
        '("client_message_id" TEXT NOT NULL, "broker_profile_id" TEXT NULL, '
        '"tool" TEXT NOT NULL, "session_id" TEXT NOT NULL, '
        '"kind" TEXT NOT NULL, "payload_json" TEXT NOT NULL, '
        '"status" TEXT NOT NULL, "attempt_count" INTEGER NOT NULL DEFAULT 0, '
        '"last_error" TEXT NULL, "created_at" INTEGER NOT NULL, '
        '"updated_at" INTEGER NOT NULL, PRIMARY KEY ("client_message_id"))',
      );
      await customStatement(
        'CREATE TABLE "session_transcript_rows" '
        '("broker_profile_id" TEXT NOT NULL, "tool" TEXT NOT NULL, '
        '"session_id" TEXT NOT NULL, "messages_json" TEXT NOT NULL, '
        '"cursor" TEXT NULL, "older_cursor" TEXT NULL, '
        '"has_earlier" INTEGER NOT NULL DEFAULT 0, "gap_json" TEXT NULL, '
        '"truncation_json" TEXT NULL, "updated_at" INTEGER NOT NULL, '
        'PRIMARY KEY ("broker_profile_id", "tool", "session_id"))',
      );
      await customStatement(
        'CREATE TABLE "session_draft_rows" '
        '("broker_profile_id" TEXT NOT NULL, "tool" TEXT NOT NULL, '
        '"session_id" TEXT NOT NULL, "draft_text" TEXT NOT NULL, '
        '"local_revision" INTEGER NOT NULL DEFAULT 0, '
        '"base_broker_revision" INTEGER NOT NULL DEFAULT 0, '
        '"dirty" INTEGER NOT NULL DEFAULT 0, '
        '"submitted_client_message_id" TEXT NULL, '
        '"mutation_version" INTEGER NOT NULL DEFAULT 0, '
        '"pending_clear_revision" INTEGER NULL, "conflict_text" TEXT NULL, '
        '"conflict_broker_revision" INTEGER NULL, '
        '"updated_at" INTEGER NOT NULL, '
        'PRIMARY KEY ("broker_profile_id", "tool", "session_id"))',
      );
      await customStatement(
        'CREATE INDEX idx_session_outbox_status_updated '
        'ON session_outbox_rows (status, updated_at)',
      );
      await customStatement(
        'CREATE INDEX idx_session_transcript_profile_updated '
        'ON session_transcript_rows (broker_profile_id, updated_at)',
      );
      await customStatement(
        'CREATE INDEX idx_session_draft_profile_updated '
        'ON session_draft_rows (broker_profile_id, updated_at)',
      );

      await customStatement(
        'INSERT INTO broker_profile_rows (id, display_name, base_uri, '
        'created_at, last_used_at, credential_key) VALUES '
        "('https://broker.example/', 'Workstation', "
        "'https://broker.example/', 1000, 2000, 'cred-v16')",
      );
      await customStatement(
        'INSERT INTO app_setting_rows (key, value, updated_at) VALUES '
        "('active_broker_profile_id', 'https://broker.example/', 1000)",
      );
      await customStatement(
        'INSERT INTO artifact_transfer_rows (id, broker_profile_id, tool, '
        'session_id, action_key, file_name, direction, status, created_at, '
        "updated_at) VALUES ('transfer-v16', 'https://broker.example/', "
        "'codex', 'session-1', 'download', 'report.pdf', 'download', "
        "'completed', 1000, 1000)",
      );
      await customStatement(
        'INSERT INTO attention_event_rows (broker_profile_id, event_id, '
        'cursor, revision, presentation_revision, kind, state, severity, '
        'dedupe_key, title, session_title, local_dismissed_revision, '
        'created_at, updated_at, raw_event_json, persisted_at) VALUES '
        "('https://broker.example/', 'event-v16', 7, 7, 2, 'permission', "
        "'active', 'actionRequired', 'dedupe-v16', 'Needs a decision', "
        "'Attention session', 4, 1000, 1000, "
        '\'{"id":"event-v16","futureField":{"keep":true}}\', 1000)',
      );
      await customStatement(
        'INSERT INTO attention_cursor_rows (broker_profile_id, cursor, '
        'initial_sync_complete, persisted_at) VALUES '
        "('https://broker.example/', 42, 1, 1000)",
      );
      await customStatement(
        'INSERT INTO session_outbox_rows (client_message_id, '
        'broker_profile_id, tool, session_id, kind, payload_json, status, '
        "attempt_count, created_at, updated_at) VALUES ('cm-v16', "
        "'https://broker.example/', 'codex', 'session-1', 'prompt', "
        '\'{"text":"v16 prompt"}\', \'queued\', 0, 1000, 1000)',
      );
      await customStatement(
        'INSERT INTO session_transcript_rows (broker_profile_id, tool, '
        'session_id, messages_json, older_cursor, has_earlier, updated_at) '
        "VALUES ('https://broker.example/', 'codex', 'session-1', "
        '\'[{"type":"model-output","key":"m1","text":"v16 answer"}]\', '
        "'cursor-older', 1, 1000)",
      );
      await customStatement(
        'INSERT INTO session_draft_rows (broker_profile_id, tool, session_id, '
        'draft_text, local_revision, base_broker_revision, dirty, '
        'mutation_version, pending_clear_revision, conflict_text, '
        "updated_at) VALUES ('https://broker.example/', 'codex', 'session-1', "
        "'draft written at v16', 3, 4, 1, 7, 5, 'shared version', 1000)",
      );
    },
  );
}

/// A schema-12 database with the two tables DR1 migrates, plus one useful row
/// in each, written through drift's normal onCreate path.
final class _LegacyV12Database extends GeneratedDatabase {
  _LegacyV12Database(super.executor);

  @override
  int get schemaVersion => 12;

  @override
  Iterable<TableInfo<Table, Object?>> get allTables => const [];

  @override
  MigrationStrategy get migration => MigrationStrategy(
    onCreate: (migrator) async {
      await customStatement('''
        CREATE TABLE session_outbox_rows (
          client_message_id TEXT NOT NULL PRIMARY KEY,
          broker_profile_id TEXT NULL,
          tool TEXT NOT NULL,
          session_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      ''');
      await customStatement('''
        CREATE TABLE session_transcript_rows (
          broker_profile_id TEXT NOT NULL,
          tool TEXT NOT NULL,
          session_id TEXT NOT NULL,
          messages_json TEXT NOT NULL,
          cursor TEXT NULL,
          older_cursor TEXT NULL,
          has_earlier INTEGER NOT NULL DEFAULT 0,
          gap_json TEXT NULL,
          truncation_json TEXT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (broker_profile_id, tool, session_id)
        )
      ''');
      await customStatement(
        'INSERT INTO session_outbox_rows (client_message_id, '
        'broker_profile_id, tool, session_id, kind, payload_json, status, '
        'attempt_count, created_at, updated_at) '
        "VALUES ('cm-legacy', 'local', 'codex', 'session-1', 'prompt', "
        '\'{"text":"legacy prompt"}\', \'delivered\', 1, 1000, 1000)',
      );
      await customStatement(
        'INSERT INTO session_transcript_rows (broker_profile_id, tool, '
        'session_id, messages_json, has_earlier, updated_at) VALUES '
        "('local', 'codex', 'session-1', "
        '\'[{"type":"model-output","key":"m1","text":"legacy answer"}]\', '
        '0, 1000)',
      );
    },
  );
}

/// A schema-13 database: the draft table as DR1 first shipped it, before the
/// post-send clear became conditional on the revision it targets.
final class _LegacyV13Database extends GeneratedDatabase {
  _LegacyV13Database(super.executor);

  @override
  int get schemaVersion => 13;

  @override
  Iterable<TableInfo<Table, Object?>> get allTables => const [];

  @override
  MigrationStrategy get migration => MigrationStrategy(
    onCreate: (migrator) async {
      await customStatement('''
        CREATE TABLE session_draft_rows (
          broker_profile_id TEXT NOT NULL,
          tool TEXT NOT NULL,
          session_id TEXT NOT NULL,
          draft_text TEXT NOT NULL,
          local_revision INTEGER NOT NULL DEFAULT 0,
          base_broker_revision INTEGER NOT NULL DEFAULT 0,
          dirty INTEGER NOT NULL DEFAULT 0,
          submitted_client_message_id TEXT NULL,
          conflict_text TEXT NULL,
          conflict_broker_revision INTEGER NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (broker_profile_id, tool, session_id)
        )
      ''');
      await customStatement(
        'INSERT INTO session_draft_rows (broker_profile_id, tool, session_id, '
        'draft_text, local_revision, base_broker_revision, dirty, updated_at) '
        "VALUES ('local', 'codex', 'session-1', 'draft written at v13', "
        '2, 3, 1, 1000)',
      );
    },
  );
}

/// The complete attention table at schema v15, before F4b added structured
/// session-title snapshots and revision-scoped local dismissals.
final class _LegacyV15Database extends GeneratedDatabase {
  _LegacyV15Database(super.executor);

  @override
  int get schemaVersion => 15;

  @override
  Iterable<TableInfo<Table, Object?>> get allTables => const [];

  @override
  MigrationStrategy get migration => MigrationStrategy(
    onCreate: (_) async {
      await customStatement('''
        CREATE TABLE attention_event_rows (
          broker_profile_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          cursor INTEGER NOT NULL,
          revision INTEGER NOT NULL,
          presentation_revision INTEGER NOT NULL,
          presentation_stage TEXT NULL,
          kind TEXT NOT NULL,
          state TEXT NOT NULL,
          severity TEXT NOT NULL,
          dedupe_key TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NULL,
          session_id TEXT NULL,
          request_id TEXT NULL,
          turn_id TEXT NULL,
          goal_key TEXT NULL,
          agent TEXT NULL,
          action_kind TEXT NULL,
          action_tool TEXT NULL,
          action_session_id TEXT NULL,
          action_agent TEXT NULL,
          broker_read_at INTEGER NULL,
          historical_baseline INTEGER NOT NULL DEFAULT 0,
          broker_dismissed_at INTEGER NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          resolved_at INTEGER NULL,
          local_read_at INTEGER NULL,
          local_dismissed_at INTEGER NULL,
          local_presented_revision INTEGER NOT NULL DEFAULT 0,
          raw_event_json TEXT NOT NULL,
          persisted_at INTEGER NOT NULL,
          PRIMARY KEY (broker_profile_id, event_id)
        )
      ''');
      await customStatement('''
        INSERT INTO attention_event_rows (
          broker_profile_id, event_id, cursor, revision,
          presentation_revision, kind, state, severity, dedupe_key, title,
          created_at, updated_at, raw_event_json, persisted_at
        ) VALUES (
          'local', 'event-v15', 3, 3, 1, 'future-kind', 'active',
          'informational', 'legacy-dedupe', 'Legacy attention', 1000, 1000,
          '{"id":"event-v15","futureField":{"keep":true}}', 1000
        )
      ''');
    },
  );
}
