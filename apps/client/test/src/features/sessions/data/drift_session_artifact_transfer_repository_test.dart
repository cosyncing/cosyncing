import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('DriftSessionArtifactTransferRepository', () {
    late AppDatabase database;
    late DriftSessionArtifactTransferRepository repository;

    setUp(() {
      database = AppDatabase(NativeDatabase.memory());
      repository = DriftSessionArtifactTransferRepository(database);
    });

    tearDown(() async {
      await database.close();
    });

    test('persists and loads transfers newest first', () async {
      final older = _transfer(
        id: 'older-transfer',
        status: SessionArtifactTransferStatus.cached,
        updatedAt: DateTime(2026, 6, 30, 10),
        cachedFilePath: '/tmp/report.html',
        bytesTransferred: 21,
        totalBytes: 42,
        byteLength: 42,
      );
      final newer = _transfer(
        id: 'newer-transfer',
        direction: SessionArtifactTransferDirection.preview,
        status: SessionArtifactTransferStatus.failed,
        updatedAt: DateTime(2026, 6, 30, 11),
        error: 'Network failed',
        attemptCount: 2,
      );

      await repository.upsertTransfer(older);
      await repository.upsertTransfer(newer);

      final transfers = await repository.loadTransfers();

      expect(transfers.map((transfer) => transfer.id), [
        'newer-transfer',
        'older-transfer',
      ]);
      expect(
        transfers.first.direction,
        SessionArtifactTransferDirection.preview,
      );
      expect(transfers.first.status, SessionArtifactTransferStatus.failed);
      expect(transfers.first.error, 'Network failed');
      expect(transfers.first.attemptCount, 2);
      expect(transfers.last.cachedFilePath, '/tmp/report.html');
      expect(transfers.last.bytesTransferred, 21);
      expect(transfers.last.totalBytes, 42);
      expect(transfers.last.byteLength, 42);
    });

    test(
      'round-trips upload metadata including uploadId and offsets',
      () async {
        await repository.upsertTransfer(
          _transfer(
            id: 'upload-transfer',
            direction: SessionArtifactTransferDirection.upload,
            status: SessionArtifactTransferStatus.running,
            uploadId: 'upload-1',
            contentHash: 'sha256:running',
            byteLength: 99,
            bytesTransferred: 12,
            totalBytes: 99,
          ),
        );

        final transfer = (await repository.loadTransfers()).single;
        expect(transfer.direction, SessionArtifactTransferDirection.upload);
        expect(transfer.uploadId, 'upload-1');
        expect(transfer.contentHash, 'sha256:running');
        expect(transfer.byteLength, 99);
        expect(transfer.bytesTransferred, 12);
        expect(transfer.totalBytes, 99);
      },
    );

    test('round-trips durable workspace download checkpoints', () async {
      await repository.upsertTransfer(
        _transfer(
          id: 'download-transfer',
          brokerProfileId: 'profile-a',
          status: SessionArtifactTransferStatus.running,
          partialFilePath: '/cache/report.bin.part',
          downloadEtag: '"report-v1"',
          downloadLastModified: 'Fri, 17 Jul 2026 12:00:00 GMT',
          bytesTransferred: 512,
          totalBytes: 2048,
        ),
      );

      final transfer = (await repository.loadTransfers()).single;
      expect(transfer.brokerProfileId, 'profile-a');
      expect(transfer.partialFilePath, '/cache/report.bin.part');
      expect(transfer.downloadEtag, '"report-v1"');
      expect(
        transfer.downloadLastModified,
        'Fri, 17 Jul 2026 12:00:00 GMT',
      );
      expect(transfer.bytesTransferred, 512);
      expect(transfer.totalBytes, 2048);
    });

    test('upsert replaces existing transfer rows', () async {
      await repository.upsertTransfer(
        _transfer(
          id: 'same-transfer',
          status: SessionArtifactTransferStatus.queued,
        ),
      );
      await repository.upsertTransfer(
        _transfer(
          id: 'same-transfer',
          status: SessionArtifactTransferStatus.completed,
          message: 'Saved report.html',
          exportedPath: '/downloads/report.html',
        ),
      );

      final transfers = await repository.loadTransfers();

      expect(transfers, hasLength(1));
      expect(transfers.single.status, SessionArtifactTransferStatus.completed);
      expect(transfers.single.message, 'Saved report.html');
      expect(transfers.single.exportedPath, '/downloads/report.html');
    });

    test('deleteTerminalTransfers keeps only active rows', () async {
      await repository.upsertTransfer(
        _transfer(
          id: 'queued-transfer',
          status: SessionArtifactTransferStatus.queued,
          updatedAt: DateTime(2026, 6, 30, 10),
        ),
      );
      await repository.upsertTransfer(
        _transfer(
          id: 'running-transfer',
          status: SessionArtifactTransferStatus.running,
          updatedAt: DateTime(2026, 6, 30, 11),
        ),
      );
      await repository.upsertTransfer(
        _transfer(
          id: 'failed-transfer',
          status: SessionArtifactTransferStatus.failed,
        ),
      );
      await repository.upsertTransfer(
        _transfer(
          id: 'completed-transfer',
          status: SessionArtifactTransferStatus.completed,
        ),
      );

      await repository.deleteTerminalTransfers();

      final transfers = await repository.loadTransfers();

      expect(transfers.map((transfer) => transfer.id), [
        'running-transfer',
        'queued-transfer',
      ]);
    });

    group('schema migration', () {
      test('migrates v8 rows without uploadId', () async {
        final v8Database = _seedV8Database();

        final v8Repository = DriftSessionArtifactTransferRepository(v8Database);
        final transfers = await v8Repository.loadTransfers();

        expect(transfers, hasLength(1));
        expect(transfers.single.id, 'legacy-upload');
        expect(
          transfers.single.direction,
          SessionArtifactTransferDirection.upload,
        );
        expect(transfers.single.uploadId, isNull);
        expect(transfers.single.brokerProfileId, isNull);
        expect(transfers.single.status, SessionArtifactTransferStatus.failed);
        expect(transfers.single.error, contains('no broker profile'));
        expect(transfers.single.contentHash, 'sha256:legacy');
        expect(transfers.single.byteLength, 6);
        expect(transfers.single.bytesTransferred, 3);
        final legacyOutbox = await v8Database
            .customSelect(
              'SELECT status, last_error FROM session_outbox_rows '
              "WHERE client_message_id = 'legacy-message'",
            )
            .getSingle();
        expect(legacyOutbox.data['status'], 'failed');
        expect(
          legacyOutbox.data['last_error'],
          contains('no broker profile'),
        );

        await v8Database.close();
      });
    });
  });
}

SessionArtifactTransfer _transfer({
  required String id,
  required SessionArtifactTransferStatus status,
  String? brokerProfileId,
  SessionArtifactTransferDirection direction =
      SessionArtifactTransferDirection.download,
  String? uploadId,
  String? partialFilePath,
  String? downloadEtag,
  String? downloadLastModified,
  String? contentHash,
  DateTime? updatedAt,
  int attemptCount = 0,
  String? cachedFilePath,
  String? exportedPath,
  int? byteLength,
  int? bytesTransferred,
  int? totalBytes,
  String? error,
  String message = '',
}) {
  final createdAt = DateTime(2026, 6, 30, 9);
  return SessionArtifactTransfer(
    id: id,
    brokerProfileId: brokerProfileId,
    sessionKey: const SessionDetailKey(tool: 'claude', sessionId: 'session-1'),
    actionKey: 'artifact-1',
    fileName: 'report.html',
    direction: direction,
    status: status,
    attemptCount: attemptCount,
    artifactKey: 'artifact-1',
    sourceUrl: '/artifact/artifact-1',
    cachedFilePath: cachedFilePath,
    exportedPath: exportedPath,
    contentType: 'text/html',
    contentHash: contentHash ?? 'sha256:abc',
    uploadId: uploadId,
    partialFilePath: partialFilePath,
    downloadEtag: downloadEtag,
    downloadLastModified: downloadLastModified,
    byteLength: byteLength,
    bytesTransferred: bytesTransferred,
    totalBytes: totalBytes,
    error: error,
    message: message,
    createdAt: createdAt,
    updatedAt: updatedAt ?? createdAt,
  );
}

AppDatabase _seedV8Database() {
  return AppDatabase(
    NativeDatabase.memory(
      setup: (executor) {
        executor
          ..execute('PRAGMA user_version = 8')
          ..execute('''
          CREATE TABLE artifact_transfer_rows (
            id TEXT NOT NULL PRIMARY KEY,
            tool TEXT NOT NULL,
            session_id TEXT NOT NULL,
            action_key TEXT NOT NULL,
            file_name TEXT NOT NULL,
            direction TEXT NOT NULL,
            status TEXT NOT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            artifact_key TEXT,
            source_url TEXT,
            cached_file_path TEXT,
            exported_path TEXT,
            content_type TEXT,
            content_hash TEXT,
            byte_length INTEGER,
            bytes_transferred INTEGER,
            total_bytes INTEGER,
            error TEXT,
            message TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
        ''')
          ..execute('''
          INSERT INTO artifact_transfer_rows (
            id, tool, session_id, action_key, file_name, direction, status,
            attempt_count, artifact_key, source_url, cached_file_path,
            exported_path, content_type, content_hash, byte_length,
            bytes_transferred, total_bytes, error, message, created_at,
            updated_at
          ) VALUES (
            'legacy-upload', 'claude', 'session-1', 'artifact-1', 'report.html',
            'upload', 'running', 0, 'artifact-1', '/artifact/artifact-1', NULL,
            NULL, 'text/plain', 'sha256:legacy', 6, 3, 6, NULL, '', 0, 0
          );
        ''')
          ..execute('''
          CREATE TABLE session_outbox_rows (
            client_message_id TEXT NOT NULL PRIMARY KEY,
            tool TEXT NOT NULL,
            session_id TEXT NOT NULL,
            kind TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            status TEXT NOT NULL,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
        ''')
          ..execute('''
          INSERT INTO session_outbox_rows (
            client_message_id, tool, session_id, kind, payload_json, status,
            attempt_count, last_error, created_at, updated_at
          ) VALUES (
            'legacy-message', 'claude', 'session-1', 'prompt',
            '{"text":"legacy"}', 'retryable', 1, NULL, 0, 0
          );
        ''');
      },
    ),
  );
}
