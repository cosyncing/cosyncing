import 'dart:async';

import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('SessionArtifactTransferController', () {
    const sessionKey = SessionDetailKey(tool: 'claude', sessionId: 'session-1');
    const descriptor = SessionArtifactDescriptor(
      name: 'report.html',
      mimeType: 'text/html',
      artifactKey: 'artifact-1',
      fetchUrl: '/artifact/artifact-1',
    );

    late ProviderContainer container;

    setUp(() {
      container = ProviderContainer(
        overrides: [
          sessionArtifactTransferRepositoryProvider.overrideWithValue(
            InMemorySessionArtifactTransferRepository(),
          ),
        ],
      );
    });

    tearDown(() {
      container.dispose();
    });

    test('queues transfers newest first with session identity', () {
      final controller = container.read(
        sessionArtifactTransferControllerProvider.notifier,
      );

      final first = controller.queueTransfer(
        sessionKey: sessionKey,
        descriptor: descriptor,
        direction: SessionArtifactTransferDirection.download,
      );
      final second = controller.queueTransfer(
        sessionKey: sessionKey,
        descriptor: descriptor,
        direction: SessionArtifactTransferDirection.preview,
      );

      final transfers = container.read(
        sessionArtifactTransferControllerProvider,
      );
      expect(transfers.map((transfer) => transfer.id), [second, first]);
      expect(transfers.first.sessionKey, sessionKey);
      expect(transfers.first.actionKey, 'artifact-1');
      expect(transfers.first.status, SessionArtifactTransferStatus.queued);
      expect(transfers.first.fileName, 'report.html');
    });

    test('queues upload transfer rows with upload direction metadata', () {
      final controller = container.read(
        sessionArtifactTransferControllerProvider.notifier,
      );

      final id = controller.queueUploadTransfer(
        sessionKey: sessionKey,
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        byteLength: 5,
        contentHash: 'sha256:example',
      );

      final transfer = container
          .read(sessionArtifactTransferControllerProvider)
          .singleWhere((item) => item.id == id);

      expect(transfer.direction, SessionArtifactTransferDirection.upload);
      expect(transfer.directionLabel, 'Upload');
      expect(transfer.fileName, 'notes.txt');
      expect(transfer.contentType, 'text/plain');
      expect(transfer.contentHash, 'sha256:example');
      expect(transfer.totalBytes, 5);
      expect(transfer.byteLength, 5);
      expect(transfer.bytesTransferred, 0);
      expect(transfer.retryDescriptor, isNull);
    });

    test('canSelectFileToResumeUpload eligibility matrix', () {
      final validHash = 'sha256:${'a' * 64}';
      final invalidHash = 'sha256:${'a' * 63}';
      final uppercaseHash = 'sha256:${'A' * 64}';

      final cases =
          <
            ({
              SessionArtifactTransferStatus status,
              SessionArtifactTransferDirection direction,
              String? uploadId,
              int? byteLength,
              String? contentHash,
              bool expected,
            })
          >[
            (
              status: SessionArtifactTransferStatus.queued,
              direction: SessionArtifactTransferDirection.upload,
              uploadId: 'upload-1',
              byteLength: 0,
              contentHash: validHash,
              expected: true,
            ),
            (
              status: SessionArtifactTransferStatus.failed,
              direction: SessionArtifactTransferDirection.upload,
              uploadId: 'upload-1',
              byteLength: 12,
              contentHash: validHash,
              expected: true,
            ),
            (
              status: SessionArtifactTransferStatus.canceled,
              direction: SessionArtifactTransferDirection.upload,
              uploadId: 'upload-1',
              byteLength: 12,
              contentHash: validHash,
              expected: true,
            ),
            (
              status: SessionArtifactTransferStatus.running,
              direction: SessionArtifactTransferDirection.upload,
              uploadId: 'upload-1',
              byteLength: 12,
              contentHash: validHash,
              expected: false,
            ),
            (
              status: SessionArtifactTransferStatus.completed,
              direction: SessionArtifactTransferDirection.upload,
              uploadId: 'upload-1',
              byteLength: 12,
              contentHash: validHash,
              expected: false,
            ),
            (
              status: SessionArtifactTransferStatus.queued,
              direction: SessionArtifactTransferDirection.upload,
              uploadId: null,
              byteLength: 12,
              contentHash: validHash,
              expected: false,
            ),
            (
              status: SessionArtifactTransferStatus.queued,
              direction: SessionArtifactTransferDirection.upload,
              uploadId: '',
              byteLength: 12,
              contentHash: validHash,
              expected: false,
            ),
            (
              status: SessionArtifactTransferStatus.queued,
              direction: SessionArtifactTransferDirection.upload,
              uploadId: 'upload-1',
              byteLength: null,
              contentHash: validHash,
              expected: false,
            ),
            (
              status: SessionArtifactTransferStatus.queued,
              direction: SessionArtifactTransferDirection.upload,
              uploadId: 'upload-1',
              byteLength: 12,
              contentHash: null,
              expected: false,
            ),
            (
              status: SessionArtifactTransferStatus.queued,
              direction: SessionArtifactTransferDirection.download,
              uploadId: 'upload-1',
              byteLength: 12,
              contentHash: validHash,
              expected: false,
            ),
            (
              status: SessionArtifactTransferStatus.queued,
              direction: SessionArtifactTransferDirection.upload,
              uploadId: 'upload-1',
              byteLength: 12,
              contentHash: invalidHash,
              expected: false,
            ),
            (
              status: SessionArtifactTransferStatus.queued,
              direction: SessionArtifactTransferDirection.upload,
              uploadId: 'upload-1',
              byteLength: 12,
              contentHash: uppercaseHash,
              expected: false,
            ),
            (
              status: SessionArtifactTransferStatus.queued,
              direction: SessionArtifactTransferDirection.upload,
              uploadId: 'upload-1',
              byteLength: -1,
              contentHash: validHash,
              expected: false,
            ),
          ];

      for (final entry in cases) {
        final transfer = _transfer(
          id: 'can-select-${entry.status}-${entry.direction}',
          status: entry.status,
          direction: entry.direction,
          uploadId: entry.uploadId,
          byteLength: entry.byteLength,
          contentHash: entry.contentHash,
        );
        expect(
          transfer.canSelectFileToResumeUpload,
          entry.expected,
          reason: '${entry.status} ${entry.direction}',
        );
      }
    });

    test('updateUploadState clear flags clear only requested fields', () async {
      final validHash = 'sha256:${'a' * 64}';
      final controller = container.read(
        sessionArtifactTransferControllerProvider.notifier,
      );
      final transferId = controller.queueUploadTransfer(
        sessionKey: sessionKey,
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        byteLength: 12,
        contentHash: validHash,
      );

      await controller.updateUploadState(
        id: transferId,
        uploadId: 'upload-1',
        bytesTransferred: 4,
        totalBytes: 12,
      );
      await controller.updateUploadState(
        id: transferId,
        clearUploadId: true,
      );
      final clearedUploadId = controller.transferById(transferId);
      expect(clearedUploadId, isNotNull);
      expect(clearedUploadId!.uploadId, isNull);
      expect(clearedUploadId.bytesTransferred, 4);
      expect(clearedUploadId.totalBytes, 12);
      expect(clearedUploadId.byteLength, 12);
      expect(clearedUploadId.contentHash, validHash);

      await controller.updateUploadState(
        id: transferId,
        clearProgress: true,
      );
      final clearedProgress = controller.transferById(transferId);
      expect(clearedProgress, isNotNull);
      expect(clearedProgress!.uploadId, isNull);
      expect(clearedProgress.bytesTransferred, isNull);
      expect(clearedProgress.totalBytes, isNull);
      expect(clearedProgress.byteLength, 12);
      expect(clearedProgress.contentHash, validHash);
    });

    test('stores only a marker for inline data URL sources', () {
      final transfer =
          (container.read(sessionArtifactTransferControllerProvider.notifier)
                ..queueTransfer(
                  sessionKey: sessionKey,
                  descriptor: const SessionArtifactDescriptor(
                    name: 'inline.txt',
                    url: 'data:text/plain;base64,SGVsbG8=',
                  ),
                  direction: SessionArtifactTransferDirection.download,
                ))
              .transfersFor(sessionKey)
              .single;
      expect(transfer.sourceUrl, 'data:');
    });

    test('records running, cached, and exported states', () {
      final controller = container.read(
        sessionArtifactTransferControllerProvider.notifier,
      );
      final id = controller.queueTransfer(
        sessionKey: sessionKey,
        descriptor: descriptor,
        direction: SessionArtifactTransferDirection.download,
      );
      const cached = SessionArtifactCachedFile(
        cachedFilePath: '/tmp/report.html',
        fileName: 'report.html',
        contentType: 'text/html',
        byteLength: 12,
      );

      controller
        ..markRunning(id, message: 'Downloading...')
        ..markCached(id, cached, message: 'Cached report.html')
        ..markExported(
          id,
          cached,
          exportedPath: '/home/tester/report.html',
          message: 'Saved report.html',
        );

      final transfer = container
          .read(sessionArtifactTransferControllerProvider)
          .single;
      expect(transfer.status, SessionArtifactTransferStatus.completed);
      expect(transfer.cachedFilePath, '/tmp/report.html');
      expect(transfer.exportedPath, '/home/tester/report.html');
      expect(transfer.byteLength, 12);
      expect(transfer.detailLabel, 'Saved report.html');
    });

    test('records cancel and failure states', () {
      final controller = container.read(
        sessionArtifactTransferControllerProvider.notifier,
      );
      final canceled = controller.queueTransfer(
        sessionKey: sessionKey,
        descriptor: descriptor,
        direction: SessionArtifactTransferDirection.download,
      );
      final failed = controller.queueTransfer(
        sessionKey: sessionKey,
        descriptor: descriptor,
        direction: SessionArtifactTransferDirection.preview,
      );

      controller
        ..markCanceled(canceled, message: 'Save destination canceled')
        ..markFailed(failed, 'Preview failed');

      final transfers = container.read(
        sessionArtifactTransferControllerProvider,
      );
      expect(
        transfers.firstWhere((transfer) => transfer.id == canceled).status,
        SessionArtifactTransferStatus.canceled,
      );
      final failedTransfer = transfers.firstWhere(
        (transfer) => transfer.id == failed,
      );
      expect(failedTransfer.status, SessionArtifactTransferStatus.failed);
      expect(failedTransfer.error, 'Preview failed');
      expect(failedTransfer.detailLabel, 'Preview failed');
    });

    test('marks upload rows as completed with final byte totals', () {
      final controller = container.read(
        sessionArtifactTransferControllerProvider.notifier,
      );
      final id = controller.queueUploadTransfer(
        sessionKey: sessionKey,
        fileName: 'notes.txt',
        byteLength: 12,
      );

      controller.markUploaded(id, byteLength: 12, message: 'Uploaded 12 bytes');

      final transfer = container
          .read(sessionArtifactTransferControllerProvider)
          .single;
      expect(transfer.status, SessionArtifactTransferStatus.completed);
      expect(transfer.byteLength, 12);
      expect(transfer.bytesTransferred, 12);
      expect(transfer.totalBytes, 12);
      expect(transfer.message, 'Uploaded 12 bytes');
    });

    test('hydrates transfers from repository', () async {
      final seeded = _transfer(
        id: 'transfer-seeded',
        status: SessionArtifactTransferStatus.failed,
        message: 'Network failed',
      );
      final repository = _FakeSessionArtifactTransferRepository([seeded]);
      final hydratedContainer = ProviderContainer(
        overrides: [
          sessionArtifactTransferRepositoryProvider.overrideWithValue(
            repository,
          ),
        ],
      );
      addTearDown(hydratedContainer.dispose);

      await hydratedContainer
          .read(sessionArtifactTransferControllerProvider.notifier)
          .hydrate();

      expect(
        hydratedContainer.read(sessionArtifactTransferControllerProvider),
        [seeded],
      );
    });

    test('hydrate preserves transfers queued before load completes', () async {
      final seeded = _transfer(
        id: 'transfer-seeded',
        status: SessionArtifactTransferStatus.failed,
        message: 'Network failed',
      );
      final repository = _FakeSessionArtifactTransferRepository([seeded]);
      final hydratedContainer = ProviderContainer(
        overrides: [
          sessionArtifactTransferRepositoryProvider.overrideWithValue(
            repository,
          ),
        ],
      );
      addTearDown(hydratedContainer.dispose);
      final controller = hydratedContainer.read(
        sessionArtifactTransferControllerProvider.notifier,
      );
      final queued = controller.queueTransfer(
        sessionKey: sessionKey,
        descriptor: descriptor,
        direction: SessionArtifactTransferDirection.download,
      );

      await controller.hydrate();

      final transferIds = hydratedContainer
          .read(sessionArtifactTransferControllerProvider)
          .map((transfer) => transfer.id);
      expect(transferIds, containsAll([queued, 'transfer-seeded']));
    });

    test('hydrates stale running non-upload as queued to resume', () async {
      final seeded = _transfer(
        id: 'running-transfer',
        status: SessionArtifactTransferStatus.running,
        message: 'Downloading...',
        bytesTransferred: 12,
        totalBytes: 42,
      );
      final repository = _FakeSessionArtifactTransferRepository([seeded]);
      final hydratedContainer = ProviderContainer(
        overrides: [
          sessionArtifactTransferRepositoryProvider.overrideWithValue(
            repository,
          ),
        ],
      );
      addTearDown(hydratedContainer.dispose);

      await hydratedContainer
          .read(sessionArtifactTransferControllerProvider.notifier)
          .hydrate();

      final transfer = hydratedContainer
          .read(sessionArtifactTransferControllerProvider)
          .single;
      expect(transfer.status, SessionArtifactTransferStatus.queued);
      expect(
        transfer.message,
        'Queued to resume after app restart',
      );
      expect(transfer.sourceUrl, '/artifact/artifact-1');
      expect(transfer.actionKey, 'artifact-1');
      expect(transfer.fileName, 'report.html');
      expect(transfer.attemptCount, 0);
      expect(transfer.bytesTransferred, 12);
      expect(transfer.totalBytes, 42);
      expect(
        repository.saved.last.status,
        SessionArtifactTransferStatus.queued,
      );
    });

    test(
      'hydrates stale running upload with user-facing resume message',
      () async {
        final seeded = _transfer(
          id: 'running-upload-transfer',
          status: SessionArtifactTransferStatus.running,
          direction: SessionArtifactTransferDirection.upload,
          message: 'Uploading...',
          bytesTransferred: 5,
          totalBytes: 10,
          byteLength: 10,
          uploadId: 'upload-1',
          contentHash: 'sha256:${'a' * 64}',
        );
        final repository = _FakeSessionArtifactTransferRepository([seeded]);
        final hydratedContainer = ProviderContainer(
          overrides: [
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              repository,
            ),
          ],
        );
        addTearDown(hydratedContainer.dispose);

        await hydratedContainer
            .read(sessionArtifactTransferControllerProvider.notifier)
            .hydrate();

        final transfer = hydratedContainer
            .read(sessionArtifactTransferControllerProvider)
            .single;
        expect(transfer.status, SessionArtifactTransferStatus.queued);
        expect(
          transfer.message,
          'Upload was interrupted; select the file again to resume.',
        );
        expect(transfer.direction, SessionArtifactTransferDirection.upload);
        expect(transfer.uploadId, 'upload-1');
        expect(transfer.contentHash, 'sha256:${'a' * 64}');
        expect(transfer.byteLength, 10);
        expect(transfer.bytesTransferred, 5);
        expect(transfer.totalBytes, 10);
      },
    );

    test(
      'hydrates queued upload with replayable metadata and '
      'persists normalization',
      () async {
        final seeded = _transfer(
          id: 'queued-upload-transfer',
          status: SessionArtifactTransferStatus.queued,
          direction: SessionArtifactTransferDirection.upload,
          message: 'Upload interrupted',
          bytesTransferred: 0,
          totalBytes: 10,
          byteLength: 10,
          uploadId: 'upload-queued',
          contentHash: 'sha256:${'b' * 64}',
        );
        final repository = _FakeSessionArtifactTransferRepository([seeded]);
        final hydratedContainer = ProviderContainer(
          overrides: [
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              repository,
            ),
          ],
        );
        addTearDown(hydratedContainer.dispose);

        await hydratedContainer
            .read(sessionArtifactTransferControllerProvider.notifier)
            .hydrate();

        final transfer = hydratedContainer
            .read(sessionArtifactTransferControllerProvider)
            .single;
        expect(transfer.status, SessionArtifactTransferStatus.queued);
        expect(
          transfer.message,
          'Upload was interrupted; select the file again to resume.',
        );
        expect(transfer.uploadId, 'upload-queued');
        expect(transfer.contentHash, 'sha256:${'b' * 64}');
        expect(transfer.byteLength, 10);
        expect(transfer.bytesTransferred, 0);
        expect(
          repository.saved.last.message,
          'Upload was interrupted; select the file again to resume.',
        );
      },
    );

    test(
      'hydrates queued replayable upload with stale normalized error and '
      'clears it persistently',
      () async {
        final seeded = _transfer(
          id: 'queued-upload-stale-error',
          status: SessionArtifactTransferStatus.queued,
          direction: SessionArtifactTransferDirection.upload,
          message: 'Upload was interrupted; select the file again to resume.',
          bytesTransferred: 2,
          totalBytes: 10,
          byteLength: 10,
          uploadId: 'upload-stale',
          contentHash: 'sha256:${'d' * 64}',
          error: 'Transient upload error.',
        );
        final repository = _FakeSessionArtifactTransferRepository([seeded]);
        final hydratedContainer = ProviderContainer(
          overrides: [
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              repository,
            ),
          ],
        );
        addTearDown(hydratedContainer.dispose);

        await hydratedContainer
            .read(sessionArtifactTransferControllerProvider.notifier)
            .hydrate();

        final transfer = hydratedContainer
            .read(sessionArtifactTransferControllerProvider)
            .single;
        expect(transfer.status, SessionArtifactTransferStatus.queued);
        expect(
          transfer.message,
          'Upload was interrupted; select the file again to resume.',
        );
        expect(transfer.error, isNull);
        expect(repository.saved.last.error, isNull);
      },
    );

    test(
      'hydration normalizes unrecoverable upload as terminal failed state',
      () async {
        final seeded = _transfer(
          id: 'legacy-upload-transfer',
          status: SessionArtifactTransferStatus.running,
          direction: SessionArtifactTransferDirection.upload,
          message: 'Uploading...',
          bytesTransferred: 4,
          totalBytes: 10,
          byteLength: 10,
          contentHash: 'sha256:${'a' * 64}',
        );
        final repository = _FakeSessionArtifactTransferRepository([seeded]);
        final hydratedContainer = ProviderContainer(
          overrides: [
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              repository,
            ),
          ],
        );
        addTearDown(hydratedContainer.dispose);

        await hydratedContainer
            .read(sessionArtifactTransferControllerProvider.notifier)
            .hydrate();

        final transfer = hydratedContainer
            .read(sessionArtifactTransferControllerProvider)
            .single;
        expect(transfer.status, SessionArtifactTransferStatus.failed);
        expect(transfer.error, transfer.message);
        expect(
          transfer.message,
          'Upload cannot be resumed after app restart. Start a new upload '
          'from Session Detail.',
        );
        expect(transfer.uploadId, isNull);
        expect(transfer.byteLength, 10);
        expect(transfer.contentHash, 'sha256:${'a' * 64}');
        expect(transfer.bytesTransferred, 4);
        expect(transfer.totalBytes, 10);
        expect(
          repository.saved.last.status,
          SessionArtifactTransferStatus.failed,
        );
      },
    );

    test(
      'cancelTransfer marks active transfer canceled and persists',
      () async {
        final repository = _FakeSessionArtifactTransferRepository();
        final cancelContainer = ProviderContainer(
          overrides: [
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              repository,
            ),
          ],
        );
        addTearDown(cancelContainer.dispose);
        final controller = cancelContainer.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final id = controller.queueTransfer(
          sessionKey: sessionKey,
          descriptor: descriptor,
          direction: SessionArtifactTransferDirection.download,
        );
        controller
          ..markRunning(id, message: 'Downloading...')
          ..cancelTransfer(id);
        await controller.persistTransfer(id);

        final transfer = cancelContainer
            .read(sessionArtifactTransferControllerProvider)
            .single;
        expect(transfer.status, SessionArtifactTransferStatus.canceled);
        expect(transfer.message, 'Canceled by user');
        expect(
          repository.saved.last.status,
          SessionArtifactTransferStatus.canceled,
        );
      },
    );

    test(
      'retryTransfer requeues failed transfer and increments attempts',
      () async {
        final repository = _FakeSessionArtifactTransferRepository();
        final retryContainer = ProviderContainer(
          overrides: [
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              repository,
            ),
          ],
        );
        addTearDown(retryContainer.dispose);
        final controller = retryContainer.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final id = controller.queueTransfer(
          sessionKey: sessionKey,
          descriptor: descriptor,
          direction: SessionArtifactTransferDirection.download,
        );
        controller
          ..markFailed(id, 'Network failed')
          ..retryTransfer(id);
        await controller.persistTransfer(id);

        final transfer = retryContainer
            .read(sessionArtifactTransferControllerProvider)
            .single;
        expect(transfer.status, SessionArtifactTransferStatus.queued);
        expect(transfer.attemptCount, 1);
        expect(transfer.error, isNull);
        expect(transfer.message, 'Queued for retry');
        expect(
          repository.saved.last.status,
          SessionArtifactTransferStatus.queued,
        );
      },
    );

    test(
      'retryTransfer preserves upload progress for resumable failed uploads',
      () async {
        final repository = _FakeSessionArtifactTransferRepository();
        final retryContainer = ProviderContainer(
          overrides: [
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              repository,
            ),
          ],
        );
        addTearDown(retryContainer.dispose);
        final controller = retryContainer.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final id = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          fileName: 'resume.bin',
          byteLength: 10,
          contentHash: 'sha256:${'c' * 64}',
        );
        await controller.updateUploadState(
          id: id,
          uploadId: 'upload-1',
          bytesTransferred: 3,
          totalBytes: 10,
        );
        controller
          ..markFailed(id, 'Network failed')
          ..retryTransfer(id);
        await controller.persistTransfer(id);

        final transfer = retryContainer
            .read(sessionArtifactTransferControllerProvider)
            .single;
        expect(transfer.status, SessionArtifactTransferStatus.queued);
        expect(transfer.attemptCount, 1);
        expect(transfer.uploadId, 'upload-1');
        expect(transfer.contentHash, 'sha256:${'c' * 64}');
        expect(transfer.byteLength, 10);
        expect(transfer.bytesTransferred, 3);
        expect(transfer.totalBytes, 10);
        expect(
          repository.saved.last.status,
          SessionArtifactTransferStatus.queued,
        );
        expect(repository.saved.last.attemptCount, 1);
        expect(repository.saved.last.uploadId, 'upload-1');
        expect(repository.saved.last.bytesTransferred, 3);
        expect(repository.saved.last.totalBytes, 10);
      },
    );

    test('filters transfers by session and clears terminal transfers', () {
      final controller = container.read(
        sessionArtifactTransferControllerProvider.notifier,
      );
      final first = controller.queueTransfer(
        sessionKey: sessionKey,
        descriptor: descriptor,
        direction: SessionArtifactTransferDirection.download,
      );
      controller
        ..queueTransfer(
          sessionKey: const SessionDetailKey(
            tool: 'claude',
            sessionId: 'session-2',
          ),
          descriptor: descriptor,
          direction: SessionArtifactTransferDirection.download,
        )
        ..markFailed(first, 'Failed');

      expect(controller.transfersFor(sessionKey), hasLength(1));

      controller.clearTerminalTransfers();

      final remaining = container.read(
        sessionArtifactTransferControllerProvider,
      );
      expect(remaining, hasLength(1));
      expect(remaining.single.sessionKey.sessionId, 'session-2');
    });

    test(
      'clearTerminalTransfers awaits terminal deletes behind in-flight updates',
      () async {
        final repository = _FakeSessionArtifactTransferRepository();
        final clearContainer = ProviderContainer(
          overrides: [
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              repository,
            ),
          ],
        );
        addTearDown(clearContainer.dispose);
        final controller = clearContainer.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final transferId = controller.queueTransfer(
          sessionKey: sessionKey,
          descriptor: descriptor,
          direction: SessionArtifactTransferDirection.download,
        );

        final failedPersistStarted = Completer<void>();
        final failedPersistAllowed = Completer<void>();
        repository.upsertDelay = (transfer) async {
          if (transfer.id == transferId &&
              transfer.status == SessionArtifactTransferStatus.failed) {
            if (!failedPersistStarted.isCompleted) {
              failedPersistStarted.complete();
            }
            await failedPersistAllowed.future;
          }
        };

        controller
          ..markFailed(transferId, 'Network failed')
          ..clearTerminalTransfers();

        await failedPersistStarted.future;
        expect(repository.deleteCompleted.isCompleted, isFalse);

        failedPersistAllowed.complete();
        await repository.deleteCompletedFuture;
        expect(
          repository.transfers.every(
            (transfer) => !_isTerminalTransfer(transfer),
          ),
          isTrue,
        );
        expect(
          repository.transfers,
          isEmpty,
        );
      },
    );
  });
}

bool _isTerminalTransfer(SessionArtifactTransfer transfer) {
  return switch (transfer.status) {
    SessionArtifactTransferStatus.completed ||
    SessionArtifactTransferStatus.canceled ||
    SessionArtifactTransferStatus.failed => true,
    _ => false,
  };
}

SessionArtifactTransfer _transfer({
  required String id,
  required SessionArtifactTransferStatus status,
  SessionArtifactTransferDirection direction =
      SessionArtifactTransferDirection.download,
  String message = '',
  String? uploadId,
  int? bytesTransferred,
  int? totalBytes,
  int? byteLength,
  String? contentHash,
  String? error,
}) {
  return SessionArtifactTransfer(
    id: id,
    sessionKey: const SessionDetailKey(tool: 'claude', sessionId: 'session-1'),
    actionKey: 'artifact-1',
    fileName: 'report.html',
    direction: direction,
    status: status,
    artifactKey: 'artifact-1',
    sourceUrl: '/artifact/artifact-1',
    bytesTransferred: bytesTransferred,
    byteLength: byteLength,
    totalBytes: totalBytes,
    uploadId: uploadId,
    contentHash: contentHash,
    error: error,
    createdAt: DateTime(2026, 6, 30),
    updatedAt: DateTime(2026, 6, 30),
    message: message,
  );
}

class _FakeSessionArtifactTransferRepository
    implements SessionArtifactTransferRepository {
  _FakeSessionArtifactTransferRepository([List<SessionArtifactTransfer>? seed])
    : _transfers = [...?seed];

  final List<SessionArtifactTransfer> _transfers;
  final saved = <SessionArtifactTransfer>[];
  final deleteCompleted = Completer<void>();
  Future<void> Function(SessionArtifactTransfer transfer)? upsertDelay;

  Future<void> get deleteCompletedFuture => deleteCompleted.future;

  List<SessionArtifactTransfer> get transfers => List.unmodifiable(_transfers);

  @override
  Future<List<SessionArtifactTransfer>> loadTransfers() async {
    return List.unmodifiable(_transfers);
  }

  @override
  Future<void> upsertTransfer(SessionArtifactTransfer transfer) async {
    final delay = upsertDelay?.call(transfer);
    if (delay != null) {
      await delay;
    }
    saved.add(transfer);
    final index = _transfers.indexWhere((item) => item.id == transfer.id);
    if (index < 0) {
      _transfers.insert(0, transfer);
    } else {
      _transfers[index] = transfer;
    }
  }

  @override
  Future<void> deleteTerminalTransfers() async {
    if (!deleteCompleted.isCompleted) {
      deleteCompleted.complete();
    }
    _transfers.removeWhere(
      (transfer) => switch (transfer.status) {
        SessionArtifactTransferStatus.completed ||
        SessionArtifactTransferStatus.canceled ||
        SessionArtifactTransferStatus.failed => true,
        _ => false,
      },
    );
  }
}
