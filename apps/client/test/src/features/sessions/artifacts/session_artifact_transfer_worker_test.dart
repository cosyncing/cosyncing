import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;
import 'dart:typed_data';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:broker_crypto/broker_crypto.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

SessionAttachment _testAttachment(
  String name,
  List<int> bytes, {
  String? mimeType,
}) => SessionAttachment(
  name: name,
  data: base64Encode(bytes),
  byteLength: bytes.length,
  mimeType: mimeType,
);

void main() {
  group('SessionArtifactTransferWorker', () {
    const sessionKey = SessionDetailKey(tool: 'claude', sessionId: 'session-1');
    const downloadDescriptor = SessionArtifactDescriptor(
      name: 'report.html',
      mimeType: 'text/html',
      artifactKey: 'artifact-1',
      contentHash: 'version-1',
      fetchUrl:
          'http://127.0.0.1:7734/api/sessions/claude/session-1/'
          'artifact/artifact-1?expires=1&sig=exact',
    );
    const previewDescriptor = SessionArtifactDescriptor(
      name: 'preview.html',
      mimeType: 'text/html',
      url: 'data:text/html;base64,PGgxPk9LPC9oMT4=',
    );

    late ProviderContainer container;
    late _FakeBrokerClient brokerClient;
    late _FakeSessionArtifactFileService fileService;
    late SessionArtifactTransferWorker worker;

    setUp(() {
      brokerClient = _FakeBrokerClient();
      fileService = _FakeSessionArtifactFileService();
      container = ProviderContainer(
        overrides: [
          sessionArtifactTransferRepositoryProvider.overrideWithValue(
            InMemorySessionArtifactTransferRepository(),
          ),
        ],
      );
      worker = SessionArtifactTransferWorker(
        brokerProfileId: 'profile-a',
        brokerClient: brokerClient,
        fileService: fileService,
        transferController: container.read(
          sessionArtifactTransferControllerProvider.notifier,
        ),
      );
    });

    tearDown(() {
      container.dispose();
    });

    test('downloadArtifact caches, exports, and completes transfer', () async {
      fileService
        ..mockCachedFile = const SessionArtifactCachedFile(
          cachedFilePath: '/tmp/report.html',
          fileName: 'report.html',
          contentType: 'text/html',
          byteLength: 42,
        )
        ..exportedPath = '/workspace/report.html';

      final result = await worker.downloadArtifact(
        sessionKey: sessionKey,
        descriptor: downloadDescriptor,
        hasActiveBrokerClient: true,
      );

      expect(result.outcome, SessionArtifactTransferWorkerOutcome.completed);
      expect(result.cachedFile?.fileName, 'report.html');
      expect(result.exportedPath, '/workspace/report.html');
      expect(fileService.cacheCallCount, 1);
      expect(fileService.exportCallCount, 1);

      final transfer = container
          .read(sessionArtifactTransferControllerProvider)
          .single;
      expect(transfer.id, result.transferId);
      expect(transfer.status, SessionArtifactTransferStatus.completed);
      expect(transfer.cachedFilePath, '/tmp/report.html');
      expect(transfer.exportedPath, '/workspace/report.html');
      expect(transfer.detailLabel, 'Saved report.html');
    });

    test(
      'downloadArtifact marks transfer canceled when export is dismissed',
      () async {
        fileService
          ..mockCachedFile = const SessionArtifactCachedFile(
            cachedFilePath: '/tmp/report.html',
            fileName: 'report.html',
            contentType: 'text/html',
            byteLength: 42,
          )
          ..exportedPath = null;

        final result = await worker.downloadArtifact(
          sessionKey: sessionKey,
          descriptor: downloadDescriptor,
          hasActiveBrokerClient: true,
        );

        expect(result.outcome, SessionArtifactTransferWorkerOutcome.canceled);
        expect(fileService.cacheCallCount, 1);
        expect(fileService.exportCallCount, 1);

        final transfer = container
            .read(sessionArtifactTransferControllerProvider)
            .single;
        expect(transfer.status, SessionArtifactTransferStatus.canceled);
        expect(transfer.detailLabel, 'Save destination canceled');
      },
    );

    test(
      'downloadArtifact fails remote work before cache without broker',
      () async {
        final result = await worker.downloadArtifact(
          sessionKey: sessionKey,
          descriptor: downloadDescriptor,
          hasActiveBrokerClient: false,
        );

        expect(result.outcome, SessionArtifactTransferWorkerOutcome.failed);
        expect(
          result.message,
          'Connect to the server before downloading this artifact.',
        );
        expect(fileService.cacheCallCount, 0);
        expect(fileService.exportCallCount, 0);

        final transfer = container
            .read(sessionArtifactTransferControllerProvider)
            .single;
        expect(transfer.status, SessionArtifactTransferStatus.failed);
        expect(
          transfer.error,
          'Connect to the server before downloading this artifact.',
        );
      },
    );

    test('preparePreview caches html artifacts without exporting', () async {
      fileService.mockCachedFile = const SessionArtifactCachedFile(
        cachedFilePath: '/tmp/preview.html',
        fileName: 'preview.html',
        contentType: 'text/html',
        byteLength: 12,
      );

      final result = await worker.preparePreview(
        sessionKey: sessionKey,
        descriptor: previewDescriptor,
        hasActiveBrokerClient: true,
      );

      expect(result.outcome, SessionArtifactTransferWorkerOutcome.cached);
      expect(result.cachedFile?.cachedFilePath, '/tmp/preview.html');
      expect(fileService.cacheCallCount, 1);
      expect(fileService.exportCallCount, 0);

      final transfer = container
          .read(sessionArtifactTransferControllerProvider)
          .single;
      expect(transfer.status, SessionArtifactTransferStatus.cached);
      expect(transfer.direction, SessionArtifactTransferDirection.preview);
      expect(transfer.detailLabel, 'Cached preview.html for preview');
    });

    test('retryTransfer re-executes failed download work', () async {
      final repository = InMemorySessionArtifactTransferRepository();
      final retryContainer = ProviderContainer(
        overrides: [
          sessionArtifactTransferRepositoryProvider.overrideWithValue(
            repository,
          ),
        ],
      );
      addTearDown(retryContainer.dispose);
      final retryController = retryContainer.read(
        sessionArtifactTransferControllerProvider.notifier,
      );
      final transferId = retryController.queueTransfer(
        sessionKey: sessionKey,
        brokerProfileId: 'profile-a',
        descriptor: downloadDescriptor,
        direction: SessionArtifactTransferDirection.download,
      );
      retryController.markFailed(transferId, 'Network failed');
      fileService
        ..mockCachedFile = const SessionArtifactCachedFile(
          cachedFilePath: '/tmp/retry-report.html',
          fileName: 'report.html',
          contentType: 'text/html',
          byteLength: 99,
        )
        ..exportedPath = '/workspace/retry-report.html';

      final retryWorker = SessionArtifactTransferWorker(
        brokerProfileId: 'profile-a',
        brokerClient: brokerClient,
        fileService: fileService,
        transferController: retryController,
      );

      final result = await retryWorker.retryTransfer(
        transferId,
        hasActiveBrokerClient: true,
      );

      expect(result.outcome, SessionArtifactTransferWorkerOutcome.completed);
      expect(result.transferId, transferId);
      expect(fileService.cacheCallCount, 1);
      expect(fileService.exportCallCount, 1);

      final transfer = retryContainer
          .read(sessionArtifactTransferControllerProvider)
          .single;
      expect(transfer.id, transferId);
      expect(transfer.status, SessionArtifactTransferStatus.completed);
      expect(transfer.attemptCount, 1);
      expect(transfer.cachedFilePath, '/tmp/retry-report.html');
      expect(transfer.exportedPath, '/workspace/retry-report.html');
      expect(transfer.error, isNull);
    });

    test('downloadArtifact rejects a reference for another session', () async {
      const descriptor = SessionArtifactDescriptor(
        name: 'other.txt',
        artifactKey: 'artifact-other',
        contentHash: 'version-other',
        fetchUrl:
            'http://127.0.0.1:7734/api/sessions/claude/session-2/'
            'artifact/artifact-other?expires=1&sig=exact',
      );

      final result = await worker.downloadArtifact(
        sessionKey: sessionKey,
        descriptor: descriptor,
        hasActiveBrokerClient: true,
      );

      expect(result.outcome, SessionArtifactTransferWorkerOutcome.failed);
      expect(
        result.message,
        'Artifact reference is not bound to this server, session, and version.',
      );
      expect(fileService.cacheCallCount, 0);
      expect(fileService.exportCallCount, 0);
    });

    test('downloadArtifact rejects a reference for another broker', () async {
      const descriptor = SessionArtifactDescriptor(
        name: 'other.txt',
        artifactKey: 'artifact-other',
        contentHash: 'version-other',
        fetchUrl:
            'https://other-broker.test/api/sessions/claude/session-1/'
            'artifact/artifact-other?expires=1&sig=exact',
      );

      final result = await worker.downloadArtifact(
        sessionKey: sessionKey,
        descriptor: descriptor,
        hasActiveBrokerClient: true,
      );

      expect(result.outcome, SessionArtifactTransferWorkerOutcome.failed);
      expect(fileService.cacheCallCount, 0);
      expect(fileService.exportCallCount, 0);
      expect(result.message, isNot(contains('other-broker.test')));
    });

    test(
      'retryTransfer rejects a row owned by another broker profile',
      () async {
        final controller = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final transferId = controller.queueTransfer(
          sessionKey: sessionKey,
          descriptor: downloadDescriptor,
          direction: SessionArtifactTransferDirection.download,
          brokerProfileId: 'profile-a',
        );
        controller.markFailed(transferId, 'Network failed');
        final otherProfileWorker = SessionArtifactTransferWorker(
          brokerProfileId: 'profile-b',
          fileService: fileService,
          transferController: controller,
        );

        final result = await otherProfileWorker.retryTransfer(
          transferId,
          hasActiveBrokerClient: true,
        );

        expect(result.outcome, SessionArtifactTransferWorkerOutcome.failed);
        expect(result.message, contains('saved server and address'));
        expect(fileService.cacheCallCount, 0);
        expect(fileService.exportCallCount, 0);
        expect(controller.transferById(transferId)?.attemptCount, 0);
      },
    );

    test('retryTransfer rejects a legacy unscoped row', () async {
      final controller = container.read(
        sessionArtifactTransferControllerProvider.notifier,
      );
      final transferId = controller.queueTransfer(
        sessionKey: sessionKey,
        descriptor: downloadDescriptor,
        direction: SessionArtifactTransferDirection.download,
      );
      controller.markFailed(transferId, 'Network failed');

      final result = await worker.retryTransfer(
        transferId,
        hasActiveBrokerClient: true,
      );

      expect(result.outcome, SessionArtifactTransferWorkerOutcome.failed);
      expect(result.message, contains('saved server and address'));
      expect(fileService.cacheCallCount, 0);
      expect(controller.transferById(transferId)?.attemptCount, 0);
    });

    test(
      'an endpoint edit fails transfers closed: the provider-built worker '
      'for the SAME profile id at a new endpoint refuses A-stamped rows '
      'with zero network work',
      () async {
        BrokerProfile profileAt(String host) => BrokerProfile(
          id: 'local',
          displayName: 'local',
          baseUri: Uri.parse('http://$host:7734'),
          createdAt: DateTime(2026, 6, 27),
        );
        // The stamp endpoint A's provider-built worker puts on its rows.
        final alphaContainer = ProviderContainer(
          overrides: [
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              InMemorySessionArtifactTransferRepository(),
            ),
            activeBrokerProfileProvider.overrideWith(
              (ref) => profileAt('alpha.invalid'),
            ),
            sessionArtifactFileServiceProvider.overrideWithValue(fileService),
          ],
        );
        addTearDown(alphaContainer.dispose);
        final alphaStamp = alphaContainer
            .read(sessionArtifactTransferWorkerProvider)
            .brokerProfileId;
        expect(
          alphaStamp,
          RosterSource.ofProfile(profileAt('alpha.invalid')).storageKey,
          reason: 'the provider binds the worker to the EXACT broker source',
        );

        // The same profile id, edited to point at endpoint B.
        final betaContainer = ProviderContainer(
          overrides: [
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              InMemorySessionArtifactTransferRepository(),
            ),
            activeBrokerProfileProvider.overrideWith(
              (ref) => profileAt('beta.invalid'),
            ),
            brokerClientProvider.overrideWith((ref) async => brokerClient),
            sessionArtifactFileServiceProvider.overrideWithValue(fileService),
          ],
        );
        addTearDown(betaContainer.dispose);
        final controller = betaContainer.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        // Rows endpoint A stamped before the profile was re-pointed.
        final downloadId = controller.queueTransfer(
          sessionKey: sessionKey,
          descriptor: downloadDescriptor,
          direction: SessionArtifactTransferDirection.download,
          brokerProfileId: alphaStamp,
        );
        controller.markFailed(downloadId, 'Network failed');
        final uploadTransferId = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          fileName: 'notes.txt',
          brokerProfileId: alphaStamp,
          byteLength: 5,
        );
        controller.markFailed(uploadTransferId, 'Network failed');

        final endpointBWorker = betaContainer.read(
          sessionArtifactTransferWorkerProvider,
        );
        final downloadRetry = await endpointBWorker.retryTransfer(
          downloadId,
          hasActiveBrokerClient: true,
        );
        final uploadResume = await endpointBWorker
            .resumeUploadSessionAttachment(
              transferId: uploadTransferId,
              attachment: _testAttachment('notes.txt', utf8.encode('hello')),
            );

        expect(
          downloadRetry.outcome,
          SessionArtifactTransferWorkerOutcome.failed,
        );
        expect(downloadRetry.message, contains('saved server and address'));
        expect(
          uploadResume.outcome,
          SessionArtifactTransferWorkerOutcome.failed,
        );
        expect(uploadResume.message, contains('saved server and address'));
        // Zero file or upload work reached endpoint B on A's behalf.
        expect(fileService.cacheCallCount, 0);
        expect(fileService.exportCallCount, 0);
        expect(brokerClient.initUploadCount, 0);
        expect(brokerClient.getUploadStatusCount, 0);
        expect(brokerClient.patchOffsets, isEmpty);
        expect(controller.transferById(downloadId)?.attemptCount, 0);
      },
    );

    test('cancelTransfer marks queued transfer canceled without file work', () {
      final transferId = container
          .read(sessionArtifactTransferControllerProvider.notifier)
          .queueTransfer(
            sessionKey: sessionKey,
            descriptor: downloadDescriptor,
            direction: SessionArtifactTransferDirection.download,
          );

      worker.cancelTransfer(transferId);

      final transfer = container
          .read(sessionArtifactTransferControllerProvider)
          .single;
      expect(transfer.status, SessionArtifactTransferStatus.canceled);
      expect(transfer.message, 'Canceled by user');
      expect(fileService.cacheCallCount, 0);
      expect(fileService.exportCallCount, 0);
    });

    test('cancelTransfer cancels running download before export', () async {
      fileService
        ..cacheStarted = Completer<void>()
        ..cacheCompleter = Completer<SessionArtifactCachedFile>()
        ..mockCachedFile = const SessionArtifactCachedFile(
          cachedFilePath: '/tmp/report.html',
          fileName: 'report.html',
          contentType: 'text/html',
          byteLength: 42,
        )
        ..exportedPath = '/workspace/report.html';

      final future = worker.downloadArtifact(
        sessionKey: sessionKey,
        descriptor: downloadDescriptor,
        hasActiveBrokerClient: true,
      );
      await fileService.cacheStarted!.future;
      final transferId = container
          .read(sessionArtifactTransferControllerProvider)
          .single
          .id;

      worker.cancelTransfer(transferId);
      fileService.cacheCompleter!.complete(fileService.mockCachedFile);

      final result = await future;

      expect(result.outcome, SessionArtifactTransferWorkerOutcome.canceled);
      expect(fileService.cacheCallCount, 1);
      expect(fileService.exportCallCount, 0);
      final transfer = container
          .read(sessionArtifactTransferControllerProvider)
          .single;
      expect(transfer.status, SessionArtifactTransferStatus.canceled);
      expect(transfer.cachedFilePath, isNull);
      expect(transfer.exportedPath, isNull);
    });

    test('downloadArtifact records byte progress from cache service', () async {
      fileService
        ..progressSteps = const [
          (bytesTransferred: 10, totalBytes: 42),
          (bytesTransferred: 42, totalBytes: 42),
        ]
        ..mockCachedFile = const SessionArtifactCachedFile(
          cachedFilePath: '/tmp/report.html',
          fileName: 'report.html',
          contentType: 'text/html',
          byteLength: 42,
        )
        ..exportedPath = '/workspace/report.html';

      final result = await worker.downloadArtifact(
        sessionKey: sessionKey,
        descriptor: downloadDescriptor,
        hasActiveBrokerClient: true,
      );

      expect(result.outcome, SessionArtifactTransferWorkerOutcome.completed);
      final transfer = container
          .read(sessionArtifactTransferControllerProvider)
          .single;
      expect(transfer.bytesTransferred, 42);
      expect(transfer.totalBytes, 42);
      expect(transfer.progressLabel, '42/42 bytes');
    });

    test('downloadSessionFile retries through session-file source', () async {
      fileService.exportedPath = '/workspace/notes.txt';

      final result = await worker.downloadSessionFile(
        sessionKey: sessionKey,
        path: 'src/notes.txt',
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        hasActiveBrokerClient: true,
      );

      expect(result.outcome, SessionArtifactTransferWorkerOutcome.completed);
      expect(fileService.sessionFileCacheCallCount, 1);
      final transfer = container
          .read(sessionArtifactTransferControllerProvider)
          .single;
      container
          .read(sessionArtifactTransferControllerProvider.notifier)
          .markFailed(transfer.id, 'retry me');

      final retryResult = await worker.retryTransfer(
        transfer.id,
        hasActiveBrokerClient: true,
      );

      expect(
        retryResult.outcome,
        SessionArtifactTransferWorkerOutcome.completed,
      );
      expect(fileService.sessionFileCacheCallCount, 2);
      expect(fileService.lastSessionFilePath, 'src/notes.txt');
    });

    test(
      'uploadSessionAttachment completes through chunked upload ledger',
      () async {
        brokerClient.completeResult = const UploadCompleteResult(
          uploadId: 'upload-1',
          stagedRef: 'stg1.final-name',
          name: 'final-name.txt',
          mimeType: 'text/plain',
          size: 6,
          expiresAt: 1783590000000,
        );

        final result = await worker.uploadSessionAttachment(
          sessionKey: sessionKey,
          attachment: _testAttachment('requested.txt', [
            1,
            2,
            3,
            4,
            5,
            6,
          ], mimeType: 'text/plain'),
        );

        expect(result.outcome, SessionArtifactTransferWorkerOutcome.completed);
        expect(result.message, contains('final-name.txt'));
        expect(result.stagedUpload, brokerClient.completeResult);
        expect(brokerClient.initUploadCount, 1);
        expect(brokerClient.patchOffsets, [0]);
        expect(brokerClient.completeUploadCount, 1);

        final transfer = container
            .read(sessionArtifactTransferControllerProvider)
            .single;
        expect(transfer.direction, SessionArtifactTransferDirection.upload);
        expect(transfer.status, SessionArtifactTransferStatus.completed);
        expect(transfer.fileName, 'final-name.txt');
        expect(
          transfer.exportedPath,
          isNull,
          reason: 'opaque prompt staging never exposes a broker path',
        );
        expect(transfer.contentType, 'text/plain');
        expect(transfer.bytesTransferred, 6);
        expect(transfer.totalBytes, 6);
      },
    );

    test(
      'uploadSessionAttachment persists fingerprint before init and '
      'uploadId before patch',
      () async {
        final bytes = [1, 2, 3, 4, 5, 6];
        final expectedHash = await sha256Digest(bytes);
        final containerWithRepository = ProviderContainer(
          overrides: [
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              _RecordingSessionArtifactTransferRepository(),
            ),
          ],
        );
        addTearDown(containerWithRepository.dispose);
        final repository =
            containerWithRepository.read(
                  sessionArtifactTransferRepositoryProvider,
                )
                as _RecordingSessionArtifactTransferRepository;
        var persistedFingerprintBeforeInit = false;
        var uploadStatePersistedBeforePatch = false;
        const longDelay = Duration(milliseconds: 40);
        const shortDelay = Duration(milliseconds: 5);
        repository.upsertDelay = (transfer) {
          final isInitialUploadRow =
              transfer.status == SessionArtifactTransferStatus.queued &&
              transfer.uploadId == null &&
              transfer.bytesTransferred == 0;
          return isInitialUploadRow ? longDelay : shortDelay;
        };
        brokerClient
          ..initUploadOffset = 3
          ..onInitUpload = () {
            final transfer = repository.latestUploadTransfer;
            expect(transfer, isNotNull);
            expect(transfer!.contentHash, expectedHash);
            expect(transfer.byteLength, 6);
            expect(transfer.totalBytes, 6);
            persistedFingerprintBeforeInit = true;
          }
          ..onPatchUpload = (offset, _) {
            final transfer = repository.latestUploadTransfer;
            expect(transfer, isNotNull);
            expect(transfer!.uploadId, isNotNull);
            expect(transfer.bytesTransferred, 3);
            expect(offset, 3);
            uploadStatePersistedBeforePatch = true;
          };

        final recordingWorker = SessionArtifactTransferWorker(
          brokerProfileId: 'profile-a',
          brokerClient: brokerClient,
          fileService: fileService,
          transferController: containerWithRepository.read(
            sessionArtifactTransferControllerProvider.notifier,
          ),
        );
        final result = await recordingWorker.uploadSessionAttachment(
          sessionKey: sessionKey,
          attachment: _testAttachment(
            'requested.txt',
            bytes,
            mimeType: 'text/plain',
          ),
        );

        expect(result.outcome, SessionArtifactTransferWorkerOutcome.completed);
        expect(result.message, contains('uploaded.bin'));
        expect(persistedFingerprintBeforeInit, true);
        expect(uploadStatePersistedBeforePatch, true);
        final finalTransfer = repository.latestUploadTransfer;
        expect(finalTransfer, isNotNull);
        expect(finalTransfer!.status, SessionArtifactTransferStatus.completed);
        expect(finalTransfer.uploadId, isNotNull);
        expect(finalTransfer.contentHash, expectedHash);
        expect(
          finalTransfer.bytesTransferred,
          finalTransfer.totalBytes,
        );
        expect(brokerClient.patchOffsets, [3]);
      },
    );

    test(
      'staged attachment hashes and uploads through bounded stream ranges',
      () async {
        const byteLength = chunkedUploadChunkBytes * 2 + 17;
        final openedRanges = <({int start, int? end})>[];
        var largestSourceChunk = 0;
        var largestPatchedChunk = 0;
        final attachment = SessionAttachment.streamed(
          name: 'large.bin',
          byteLength: byteLength,
          mimeType: 'application/octet-stream',
          openRead: ({int start = 0, int? end}) async* {
            openedRanges.add((start: start, end: end));
            final limit = end ?? byteLength;
            var cursor = start;
            while (cursor < limit) {
              final chunkLength = (limit - cursor).clamp(0, 64 * 1024);
              largestSourceChunk = math.max(
                largestSourceChunk,
                chunkLength,
              );
              yield Uint8List(chunkLength);
              cursor += chunkLength;
            }
          },
        );
        brokerClient
          ..completeResult = const UploadCompleteResult(
            uploadId: 'upload-1',
            stagedRef: 'stg1.large',
            name: 'large.bin',
            mimeType: 'application/octet-stream',
            size: byteLength,
            expiresAt: 1783590000000,
          )
          ..onPatchUpload = (_, size) {
            largestPatchedChunk = math.max(largestPatchedChunk, size);
          };

        final result = await worker.uploadSessionAttachment(
          sessionKey: sessionKey,
          attachment: attachment,
        );

        expect(result.outcome, SessionArtifactTransferWorkerOutcome.completed);
        expect(openedRanges.first, (start: 0, end: null));
        expect(
          openedRanges.skip(1),
          [
            (start: 0, end: chunkedUploadChunkBytes),
            (
              start: chunkedUploadChunkBytes,
              end: chunkedUploadChunkBytes * 2,
            ),
            (
              start: chunkedUploadChunkBytes * 2,
              end: byteLength,
            ),
          ],
        );
        expect(largestSourceChunk, lessThanOrEqualTo(64 * 1024));
        expect(
          largestPatchedChunk,
          lessThanOrEqualTo(chunkedUploadChunkBytes),
        );
      },
    );

    test(
      'selectFileToResumeUpload rejects missing and ineligible rows '
      'before picker',
      () async {
        final picker = _FakeSessionAttachmentPicker(
          onPick: () => throw StateError('picker should not run'),
        );
        final pickerWorker = SessionArtifactTransferWorker(
          brokerProfileId: 'profile-a',
          brokerClient: brokerClient,
          fileService: fileService,
          transferController: container.read(
            sessionArtifactTransferControllerProvider.notifier,
          ),
          sessionAttachmentPicker: picker,
        );

        final missingResult = await pickerWorker.selectFileToResumeUpload(
          transferId: 'missing-transfer',
        );
        expect(
          missingResult.outcome,
          SessionArtifactTransferWorkerOutcome.failed,
        );
        expect(missingResult.message, 'Transfer not found.');

        final controller = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final uploadTransfer = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'running.txt',
          byteLength: 6,
          contentHash: await sha256Digest([1, 2, 3, 4, 5, 6]),
        );
        await controller.updateUploadState(
          id: uploadTransfer,
          uploadId: 'upload-1',
          bytesTransferred: 0,
          totalBytes: 6,
        );
        controller.markRunning(uploadTransfer, message: 'Uploading');

        final runningResult = await pickerWorker.selectFileToResumeUpload(
          transferId: uploadTransfer,
        );
        expect(
          runningResult.outcome,
          SessionArtifactTransferWorkerOutcome.failed,
        );
        expect(runningResult.message, 'Transfer is not in a resumable state.');
        expect(picker.pickCallCount, 0);
        expect(brokerClient.initUploadCount, 0);
        expect(brokerClient.getUploadStatusCount, 0);
        expect(brokerClient.patchOffsets, isEmpty);
        expect(brokerClient.completeUploadCount, 0);
      },
    );

    test(
      'selectFileToResumeUpload returns useful failure when picker missing',
      () async {
        final controller = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final transferId = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          byteLength: 6,
          contentHash: await sha256Digest([1, 2, 3, 4, 5, 6]),
        );
        await controller.updateUploadState(
          id: transferId,
          uploadId: 'upload-1',
          bytesTransferred: 0,
          totalBytes: 6,
        );

        final workerWithoutPicker = SessionArtifactTransferWorker(
          brokerProfileId: 'profile-a',
          brokerClient: brokerClient,
          fileService: fileService,
          transferController: controller,
        );
        final result = await workerWithoutPicker.selectFileToResumeUpload(
          transferId: transferId,
        );
        expect(result.outcome, SessionArtifactTransferWorkerOutcome.failed);
        expect(
          result.message,
          'Upload picker is unavailable for this environment.',
        );
        expect(brokerClient.initUploadCount, 0);
        expect(brokerClient.getUploadStatusCount, 0);
        expect(brokerClient.patchOffsets, isEmpty);
        expect(brokerClient.completeUploadCount, 0);
      },
    );

    test(
      'selectFileToResumeUpload returns canceled and does not mutate '
      'snapshot or call broker APIs',
      () async {
        final controller = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final transferId = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          byteLength: 6,
          contentHash: await sha256Digest([1, 2, 3, 4, 5, 6]),
        );
        await controller.updateUploadState(
          id: transferId,
          uploadId: 'upload-1',
          bytesTransferred: 2,
          totalBytes: 6,
        );
        final before = controller.transferById(transferId);
        expect(before, isNotNull);

        final picker = _FakeSessionAttachmentPicker();
        final pickerWorker = SessionArtifactTransferWorker(
          brokerProfileId: 'profile-a',
          brokerClient: brokerClient,
          fileService: fileService,
          transferController: controller,
          sessionAttachmentPicker: picker,
        );

        final result = await pickerWorker.selectFileToResumeUpload(
          transferId: transferId,
        );
        expect(result.outcome, SessionArtifactTransferWorkerOutcome.canceled);
        expect(picker.pickCallCount, 1);
        expect(
          result.message,
          'Upload resume selection was canceled.',
        );
        expect(brokerClient.initUploadCount, 0);
        expect(brokerClient.getUploadStatusCount, 0);
        expect(brokerClient.patchOffsets, isEmpty);
        expect(brokerClient.completeUploadCount, 0);

        final after = controller.transferById(transferId);
        expect(after, isNotNull);
        expect(identical(after, before), isTrue);
      },
    );

    test(
      'selectFileToResumeUpload maps picker failures to concise outcomes and '
      'keeps upload metadata',
      () async {
        final controller = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final transferId = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          byteLength: 6,
          contentHash: await sha256Digest([1, 2, 3, 4, 5, 6]),
        );
        await controller.updateUploadState(
          id: transferId,
          uploadId: 'upload-1',
          bytesTransferred: 0,
          totalBytes: 6,
        );

        final tooLargePicker = _FakeSessionAttachmentPicker(
          onPick: () async => throw const SessionAttachmentTooLargeException(
            fileName: 'resume.txt',
            byteLength: 99,
            maxBytes: 2,
          ),
        );
        final tooLargeWorker = SessionArtifactTransferWorker(
          brokerProfileId: 'profile-a',
          brokerClient: brokerClient,
          fileService: fileService,
          transferController: controller,
          sessionAttachmentPicker: tooLargePicker,
        );
        final tooLargeResult = await tooLargeWorker.selectFileToResumeUpload(
          transferId: transferId,
        );
        final afterTooLarge = controller.transferById(transferId);
        expect(afterTooLarge, isNotNull);
        expect(afterTooLarge!.uploadId, 'upload-1');
        expect(afterTooLarge.contentHash, isNotNull);
        expect(afterTooLarge.bytesTransferred, 0);
        expect(
          tooLargeResult.outcome,
          SessionArtifactTransferWorkerOutcome.failed,
        );
        expect(
          tooLargeResult.message,
          'Selected file is too large to resume upload.',
        );
        expect(tooLargePicker.pickCallCount, 1);

        final genericFailurePicker = _FakeSessionAttachmentPicker(
          onPick: () async => throw StateError('internal picker path leak'),
        );
        final genericWorker = SessionArtifactTransferWorker(
          brokerProfileId: 'profile-a',
          brokerClient: brokerClient,
          fileService: fileService,
          transferController: controller,
          sessionAttachmentPicker: genericFailurePicker,
        );
        final genericResult = await genericWorker.selectFileToResumeUpload(
          transferId: transferId,
        );
        final afterGeneric = controller.transferById(transferId);
        expect(afterGeneric, isNotNull);
        expect(afterGeneric!.uploadId, afterTooLarge.uploadId);
        expect(afterGeneric.contentHash, afterTooLarge.contentHash);
        expect(
          genericResult.outcome,
          SessionArtifactTransferWorkerOutcome.failed,
        );
        expect(
          genericResult.message,
          'Upload resume file could not be selected.',
        );
        expect(genericFailurePicker.pickCallCount, 1);

        expect(brokerClient.initUploadCount, 0);
        expect(brokerClient.getUploadStatusCount, 0);
        expect(brokerClient.patchOffsets, isEmpty);
        expect(brokerClient.completeUploadCount, 0);
      },
    );

    test(
      'selectFileToResumeUpload resumes with picker selection without new init',
      () async {
        final bytes = [1, 2, 3, 4, 5, 6];
        final hash = await sha256Digest(bytes);
        final controller = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final transferId = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          byteLength: bytes.length,
          contentHash: hash,
        );
        await controller.updateUploadState(
          id: transferId,
          uploadId: 'upload-1',
          bytesTransferred: 3,
          totalBytes: bytes.length,
        );
        brokerClient
          ..statusUploadId = 'upload-1'
          ..statusOffset = 3
          ..statusSize = bytes.length
          ..completeResult = const UploadCompleteResult(
            uploadId: 'upload-1',
            stagedRef: 'stg1.resume',
            name: 'resume.bin',
            mimeType: 'text/plain',
            size: 6,
            expiresAt: 1783590000000,
          )
          ..initUploadCount = 0
          ..getUploadStatusCount = 0
          ..completeUploadCount = 0
          ..patchOffsets.clear();

        final picker = _FakeSessionAttachmentPicker(
          nextAttachment: SessionAttachment(
            name: 'picked-resume.txt',
            data: base64Encode(bytes),
            byteLength: bytes.length,
            mimeType: 'application/octet-stream',
          ),
        );
        final pickerWorker = SessionArtifactTransferWorker(
          brokerProfileId: 'profile-a',
          brokerClient: brokerClient,
          fileService: fileService,
          transferController: controller,
          sessionAttachmentPicker: picker,
        );

        final result = await pickerWorker.selectFileToResumeUpload(
          transferId: transferId,
        );
        expect(result.outcome, SessionArtifactTransferWorkerOutcome.completed);
        expect(result.transferId, transferId);
        expect(picker.pickCallCount, 1);
        expect(brokerClient.initUploadCount, 0);
        expect(brokerClient.getUploadStatusCount, 1);
        expect(brokerClient.patchOffsets, [3]);
        expect(brokerClient.completeUploadCount, 1);

        final transfer = controller.transferById(transferId);
        expect(transfer, isNotNull);
        expect(transfer!.uploadId, 'upload-1');
        expect(transfer.contentHash, hash);
        expect(transfer.status, SessionArtifactTransferStatus.completed);
      },
    );

    test(
      'selectFileToResumeUpload is single-flight for a transfer',
      () async {
        final bytes = [1, 2, 3, 4, 5, 6];
        final hash = await sha256Digest(bytes);
        final controller = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final transferId = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          byteLength: bytes.length,
          contentHash: hash,
        );
        await controller.updateUploadState(
          id: transferId,
          uploadId: 'upload-1',
          bytesTransferred: 3,
          totalBytes: bytes.length,
        );
        brokerClient
          ..getUploadStatusStarted = Completer<void>()
          ..getUploadStatusContinue = Completer<void>()
          ..statusUploadId = 'upload-1'
          ..statusOffset = 3
          ..statusSize = bytes.length
          ..completeResult = const UploadCompleteResult(
            uploadId: 'upload-1',
            stagedRef: 'stg1.resume',
            name: 'resume.bin',
            mimeType: 'text/plain',
            size: 6,
            expiresAt: 1783590000000,
          );

        final picker = _FakeSessionAttachmentPicker(
          nextAttachment: SessionAttachment(
            name: 'picked-resume.txt',
            data: base64Encode(bytes),
            byteLength: bytes.length,
            mimeType: 'application/octet-stream',
          ),
        );
        final pickerWorker = SessionArtifactTransferWorker(
          brokerProfileId: 'profile-a',
          brokerClient: brokerClient,
          fileService: fileService,
          transferController: controller,
          sessionAttachmentPicker: picker,
        );

        final first = pickerWorker.selectFileToResumeUpload(
          transferId: transferId,
        );
        await brokerClient.getUploadStatusStarted!.future;
        final second = pickerWorker.selectFileToResumeUpload(
          transferId: transferId,
        );
        final secondResult = await second;
        expect(
          secondResult.outcome,
          SessionArtifactTransferWorkerOutcome.failed,
        );
        expect(
          secondResult.message,
          'Upload resume is already in progress for this transfer.',
        );
        expect(picker.pickCallCount, 1);
        expect(brokerClient.getUploadStatusCount, 1);
        expect(brokerClient.patchOffsets, isEmpty);
        expect(brokerClient.completeUploadCount, 0);

        brokerClient.getUploadStatusContinue!.complete();
        final firstResult = await first;
        expect(
          firstResult.outcome,
          SessionArtifactTransferWorkerOutcome.completed,
        );
        expect(picker.pickCallCount, 1);
        expect(brokerClient.getUploadStatusCount, 1);
        expect(brokerClient.patchOffsets, [3]);
        expect(brokerClient.completeUploadCount, 1);

        final resumed = await pickerWorker.selectFileToResumeUpload(
          transferId: transferId,
        );
        expect(
          resumed.outcome,
          SessionArtifactTransferWorkerOutcome.failed,
        );
        expect(
          resumed.message,
          'Transfer is not in a resumable state.',
        );
      },
    );

    test(
      'resumeUploadSessionAttachment requires resumable state and canonical '
      'metadata',
      () async {
        final bytes = [1, 2, 3, 4, 5, 6];
        final hash = await sha256Digest(bytes);

        final runningController = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final runningTransfer = runningController.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          mimeType: 'text/plain',
          byteLength: bytes.length,
          contentHash: hash,
        );
        await runningController.updateUploadState(
          id: runningTransfer,
          uploadId: 'upload-1',
          bytesTransferred: 0,
          totalBytes: bytes.length,
        );
        runningController.markRunning(runningTransfer, message: 'Uploading');

        final runningResult = await worker.resumeUploadSessionAttachment(
          transferId: runningTransfer,
          attachment: _testAttachment(
            'resume.txt',
            bytes,
            mimeType: 'text/plain',
          ),
        );
        expect(
          runningResult.outcome,
          SessionArtifactTransferWorkerOutcome.failed,
        );
        expect(runningResult.message, 'Transfer is not in a resumable state.');

        final cachedController = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final cachedTransfer = cachedController.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          byteLength: bytes.length,
          contentHash: hash,
        );
        await cachedController.updateUploadState(
          id: cachedTransfer,
          uploadId: 'upload-2',
          bytesTransferred: 0,
          totalBytes: bytes.length,
        );
        cachedController.markCached(
          cachedTransfer,
          const SessionArtifactCachedFile(
            cachedFilePath: '/tmp/resume.bin',
            fileName: 'resume.txt',
            contentType: 'text/plain',
            byteLength: 6,
          ),
          message: 'Cached resume',
        );

        final cachedResult = await worker.resumeUploadSessionAttachment(
          transferId: cachedTransfer,
          attachment: _testAttachment(
            'resume.txt',
            bytes,
            mimeType: 'text/plain',
          ),
        );
        expect(
          cachedResult.outcome,
          SessionArtifactTransferWorkerOutcome.failed,
        );
        expect(cachedResult.message, 'Transfer is not in a resumable state.');

        final completedController = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final completedTransfer = completedController.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          byteLength: bytes.length,
          contentHash: hash,
        );
        await completedController.updateUploadState(
          id: completedTransfer,
          uploadId: 'upload-3',
          bytesTransferred: bytes.length,
          totalBytes: bytes.length,
        );
        completedController.markUploaded(
          completedTransfer,
          byteLength: bytes.length,
          contentType: 'text/plain',
          fileName: 'resume.txt',
        );

        final completedResult = await worker.resumeUploadSessionAttachment(
          transferId: completedTransfer,
          attachment: _testAttachment(
            'resume.txt',
            bytes,
            mimeType: 'text/plain',
          ),
        );
        expect(
          completedResult.outcome,
          SessionArtifactTransferWorkerOutcome.failed,
        );
        expect(
          completedResult.message,
          'Transfer already completed.',
        );
      },
    );

    test(
      'resumeUploadSessionAttachment rejects blank uploadId and bad digest',
      () async {
        final bytes = [1, 2, 3, 4, 5, 6];
        final goodDigest = await sha256Digest(bytes);
        const badDigest = 'sha256:not-a-valid-digest';
        final controller = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final blankIdTransfer = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          byteLength: bytes.length,
          contentHash: goodDigest,
        );
        await controller.updateUploadState(
          id: blankIdTransfer,
          uploadId: '   ',
          bytesTransferred: 0,
          totalBytes: bytes.length,
        );

        brokerClient
          ..initUploadCount = 0
          ..getUploadStatusCount = 0
          ..completeUploadCount = 0;

        final blankIdResult = await worker.resumeUploadSessionAttachment(
          transferId: blankIdTransfer,
          attachment: _testAttachment(
            'resume.txt',
            bytes,
            mimeType: 'text/plain',
          ),
        );
        expect(
          blankIdResult.outcome,
          SessionArtifactTransferWorkerOutcome.failed,
        );
        expect(
          blankIdResult.message,
          'Upload cannot be resumed after app restart. Start a new upload '
          'from Session Detail.',
        );

        final badDigestTransfer = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          byteLength: bytes.length,
          contentHash: badDigest,
        );
        await controller.updateUploadState(
          id: badDigestTransfer,
          uploadId: 'upload-1',
          bytesTransferred: 0,
          totalBytes: bytes.length,
        );

        final badDigestResult = await worker.resumeUploadSessionAttachment(
          transferId: badDigestTransfer,
          attachment: _testAttachment(
            'resume.txt',
            bytes,
            mimeType: 'text/plain',
          ),
        );
        expect(
          badDigestResult.outcome,
          SessionArtifactTransferWorkerOutcome.failed,
        );
        expect(
          badDigestResult.message,
          'Upload fingerprint has an invalid format.',
        );
        expect(brokerClient.initUploadCount, 0);
        expect(brokerClient.getUploadStatusCount, 0);
        expect(brokerClient.patchOffsets, isEmpty);
        expect(brokerClient.completeUploadCount, 0);
      },
    );

    test(
      'resumeUploadSessionAttachment accepts uploadId with surrounding '
      'whitespace',
      () async {
        final bytes = [1, 2, 3, 4, 5, 6];
        final hash = await sha256Digest(bytes);
        final controller = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final transferId = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          byteLength: bytes.length,
          contentHash: hash,
        );
        await controller.updateUploadState(
          id: transferId,
          uploadId: '  upload-1  ',
          bytesTransferred: 0,
          totalBytes: bytes.length,
        );
        brokerClient
          ..statusUploadId = '  upload-1  '
          ..statusOffset = 3
          ..statusSize = bytes.length
          ..completeUploadCount = 0;

        final result = await worker.resumeUploadSessionAttachment(
          transferId: transferId,
          attachment: _testAttachment(
            'resume.txt',
            bytes,
            mimeType: 'text/plain',
          ),
        );
        expect(result.outcome, SessionArtifactTransferWorkerOutcome.completed);
        expect(brokerClient.patchOffsets, [3]);
      },
    );

    test(
      'resumeUploadSessionAttachment accepts zero-byte canonical uploads',
      () async {
        final emptyDigest = await sha256Digest([]);
        final controller = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final transferId = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          byteLength: 0,
          contentHash: emptyDigest,
        );
        await controller.updateUploadState(
          id: transferId,
          uploadId: 'upload-1',
          bytesTransferred: 0,
          totalBytes: 0,
        );
        brokerClient
          ..statusUploadId = 'upload-1'
          ..statusOffset = 0
          ..statusSize = 0
          ..completeResult = const UploadCompleteResult(
            uploadId: 'upload-1',
            stagedRef: 'stg1.zero',
            name: 'zero.bin',
            mimeType: 'application/octet-stream',
            size: 0,
            expiresAt: 1783590000000,
          );

        final result = await worker.resumeUploadSessionAttachment(
          transferId: transferId,
          attachment: _testAttachment('resume.txt', []),
        );
        expect(result.outcome, SessionArtifactTransferWorkerOutcome.completed);
        expect(result.message, contains('zero.bin'));
        expect(
          brokerClient.patchOffsets,
          isEmpty,
        );

        final transfer = container
            .read(sessionArtifactTransferControllerProvider)
            .singleWhere((item) => item.id == transferId);
        expect(transfer.status, SessionArtifactTransferStatus.completed);
        expect(transfer.byteLength, 0);
        expect(transfer.totalBytes, 0);
      },
    );

    test('uploadSessionAttachment resyncs after offset mismatch', () async {
      brokerClient
        ..mismatchOnceAtOffset = 0
        ..expectedOffsetAfterMismatch = 3;

      final result = await worker.uploadSessionAttachment(
        sessionKey: sessionKey,
        attachment: _testAttachment('resume.bin', [1, 2, 3, 4, 5, 6]),
      );

      expect(result.outcome, SessionArtifactTransferWorkerOutcome.completed);
      expect(brokerClient.patchOffsets, [0, 3]);
      final transfer = container
          .read(sessionArtifactTransferControllerProvider)
          .single;
      expect(transfer.status, SessionArtifactTransferStatus.completed);
      expect(transfer.bytesTransferred, 6);
    });

    test(
      'uploadSessionAttachment rejects invalid init metadata before any data '
      'upload',
      () async {
        final bytes = [1, 2, 3, 4, 5, 6];

        brokerClient
          ..initUploadId = 'wrong-id'
          ..initUploadSize = 9
          ..initUploadOffset = 0
          ..initUploadCount = 0
          ..getUploadStatusCount = 0
          ..completeUploadCount = 0;

        final wrongId = await worker.uploadSessionAttachment(
          sessionKey: sessionKey,
          attachment: _testAttachment(
            'resume.bin',
            bytes,
            mimeType: 'text/plain',
          ),
        );
        expect(wrongId.outcome, SessionArtifactTransferWorkerOutcome.failed);
        expect(brokerClient.initUploadCount, 1);
        expect(brokerClient.getUploadStatusCount, 0);
        expect(brokerClient.patchOffsets, isEmpty);
        expect(brokerClient.completeUploadCount, 0);
      },
    );

    test(
      'resumeUploadSessionAttachment rejects status id mismatch before '
      'patching',
      () async {
        final bytes = [1, 2, 3, 4, 5, 6];
        final hash = await sha256Digest(bytes);
        final controller = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final transferId = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          byteLength: bytes.length,
          contentHash: hash,
        );
        await controller.updateUploadState(
          id: transferId,
          uploadId: 'upload-1',
          bytesTransferred: 0,
          totalBytes: bytes.length,
        );

        brokerClient
          ..statusUploadId = 'wrong-id'
          ..statusOffset = 0
          ..statusSize = bytes.length
          ..getUploadStatusCount = 0
          ..patchOffsets.clear()
          ..completeUploadCount = 0;

        final result = await worker.resumeUploadSessionAttachment(
          transferId: transferId,
          attachment: _testAttachment(
            'resume.txt',
            bytes,
            mimeType: 'text/plain',
          ),
        );
        expect(result.outcome, SessionArtifactTransferWorkerOutcome.failed);
        expect(brokerClient.getUploadStatusCount, 1);
        expect(brokerClient.patchOffsets, isEmpty);
        expect(brokerClient.completeUploadCount, 0);
      },
    );

    test(
      'resumeUploadSessionAttachment rejects status size mismatch before '
      'patching',
      () async {
        final bytes = [1, 2, 3, 4, 5, 6];
        final hash = await sha256Digest(bytes);
        final controller = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final transferId = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          byteLength: bytes.length,
          contentHash: hash,
        );
        await controller.updateUploadState(
          id: transferId,
          uploadId: 'upload-1',
          bytesTransferred: 0,
          totalBytes: bytes.length,
        );

        brokerClient
          ..statusUploadId = 'upload-1'
          ..statusOffset = 0
          ..statusSize = 9
          ..getUploadStatusCount = 0
          ..patchOffsets.clear()
          ..completeUploadCount = 0;

        final result = await worker.resumeUploadSessionAttachment(
          transferId: transferId,
          attachment: _testAttachment(
            'resume.txt',
            bytes,
            mimeType: 'text/plain',
          ),
        );
        expect(result.outcome, SessionArtifactTransferWorkerOutcome.failed);
        expect(brokerClient.getUploadStatusCount, 1);
        expect(brokerClient.patchOffsets, isEmpty);
        expect(brokerClient.completeUploadCount, 0);
      },
    );

    test(
      'resumeUploadSessionAttachment rejects patch metadata mismatch',
      () async {
        final bytes = [1, 2, 3, 4, 5, 6];
        final hash = await sha256Digest(bytes);
        final controller = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final transferId = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          byteLength: bytes.length,
          contentHash: hash,
        );
        await controller.updateUploadState(
          id: transferId,
          uploadId: 'upload-1',
          bytesTransferred: 0,
          totalBytes: bytes.length,
        );

        brokerClient
          ..statusUploadId = 'upload-1'
          ..statusOffset = 3
          ..statusSize = bytes.length
          ..getUploadStatusCount = 0
          ..patchUploadId = 'wrong-id'
          ..patchUploadSize = 9
          ..patchOffsets.clear()
          ..completeUploadCount = 0;

        final result = await worker.resumeUploadSessionAttachment(
          transferId: transferId,
          attachment: _testAttachment(
            'resume.txt',
            bytes,
            mimeType: 'text/plain',
          ),
        );
        expect(result.outcome, SessionArtifactTransferWorkerOutcome.failed);
        expect(brokerClient.getUploadStatusCount, 1);
        expect(brokerClient.patchOffsets, [3]);
        expect(brokerClient.completeUploadCount, 0);
      },
    );

    test(
      'resumeUploadSessionAttachment resumes from persisted uploadId '
      'and status',
      () async {
        final bytes = [1, 2, 3, 4, 5, 6];
        final hash = await sha256Digest(bytes);
        final controller = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final transferId = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          mimeType: 'text/plain',
          byteLength: bytes.length,
          contentHash: hash,
        );
        await controller.updateUploadState(
          id: transferId,
          uploadId: 'upload-1',
          bytesTransferred: 0,
          totalBytes: bytes.length,
        );
        brokerClient
          ..statusOffset = 3
          ..initUploadCount = 0
          ..completeUploadCount = 0
          ..getUploadStatusCount = 0;

        final result = await worker.resumeUploadSessionAttachment(
          transferId: transferId,
          attachment: _testAttachment(
            'resume.txt',
            bytes,
            mimeType: 'text/plain',
          ),
        );

        expect(result.outcome, SessionArtifactTransferWorkerOutcome.completed);
        expect(brokerClient.initUploadCount, 0);
        expect(brokerClient.getUploadStatusCount, 1);
        expect(brokerClient.patchOffsets, [3]);
        expect(brokerClient.completeUploadCount, 1);
        final transfer = container
            .read(sessionArtifactTransferControllerProvider)
            .singleWhere((item) => item.id == transferId);
        expect(transfer.uploadId, 'upload-1');
        expect(transfer.bytesTransferred, bytes.length);
      },
    );

    test(
      'verified re-pick supports failed retry without reinitializing upload',
      () async {
        final bytes = [1, 2, 3, 4, 5, 6];
        final hash = await sha256Digest(bytes);
        final controller = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final transferId = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          mimeType: 'text/plain',
          byteLength: bytes.length,
          contentHash: hash,
        );
        await controller.updateUploadState(
          id: transferId,
          uploadId: 'upload-1',
          bytesTransferred: 0,
          totalBytes: bytes.length,
        );

        brokerClient
          ..statusOffset = 0
          ..initUploadCount = 0
          ..getUploadStatusCount = 0
          ..completeUploadCount = 0
          ..failPatchOnce = true;

        final failed = await worker.resumeUploadSessionAttachment(
          transferId: transferId,
          attachment: _testAttachment(
            'resume.txt',
            bytes,
            mimeType: 'text/plain',
          ),
        );
        expect(failed.outcome, SessionArtifactTransferWorkerOutcome.failed);
        expect(failed.transferId, transferId);
        expect(controller.transferById(transferId)?.uploadId, 'upload-1');
        expect(brokerClient.initUploadCount, 0);

        brokerClient
          ..failPatchOnce = false
          ..statusOffset = 0
          ..getUploadStatusCount = 0
          ..patchOffsets.clear()
          ..completeUploadCount = 0;

        final retried = await worker.retryTransfer(
          transferId,
          hasActiveBrokerClient: true,
        );
        expect(retried.outcome, SessionArtifactTransferWorkerOutcome.completed);
        expect(retried.transferId, transferId);
        expect(brokerClient.initUploadCount, 0);
        expect(brokerClient.getUploadStatusCount, 1);
        expect(brokerClient.patchOffsets, [0]);
        final transfer = container
            .read(sessionArtifactTransferControllerProvider)
            .firstWhere((item) => item.id == transferId);
        expect(transfer.status, SessionArtifactTransferStatus.completed);
        expect(transfer.uploadId, 'upload-1');
        expect(transfer.attemptCount, 1);
      },
    );

    test(
      'resumeUploadSessionAttachment rejects size or hash mismatches before '
      'broker calls',
      () async {
        final controller = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final transferId = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          byteLength: 6,
          contentHash: await sha256Digest([1, 2, 3, 4, 5, 6]),
        );
        await controller.updateUploadState(
          id: transferId,
          uploadId: 'upload-1',
          bytesTransferred: 0,
          totalBytes: 6,
        );

        final resultBadSize = await worker.resumeUploadSessionAttachment(
          transferId: transferId,
          attachment: _testAttachment(
            'resume.txt',
            [1, 2, 3, 4, 5],
          ),
        );
        expect(
          resultBadSize.outcome,
          SessionArtifactTransferWorkerOutcome.failed,
        );
        expect(brokerClient.initUploadCount, 0);
        expect(brokerClient.getUploadStatusCount, 0);
        expect(brokerClient.patchOffsets, isEmpty);
        expect(brokerClient.completeUploadCount, 0);

        brokerClient
          ..initUploadCount = 0
          ..getUploadStatusCount = 0
          ..completeUploadCount = 0;
        final resultBadHash = await worker.resumeUploadSessionAttachment(
          transferId: transferId,
          attachment: _testAttachment('resume.txt', [6, 5, 4, 3, 2, 1]),
        );
        expect(
          resultBadHash.outcome,
          SessionArtifactTransferWorkerOutcome.failed,
        );
        expect(brokerClient.initUploadCount, 0);
        expect(brokerClient.getUploadStatusCount, 0);
        expect(brokerClient.patchOffsets, isEmpty);
        expect(brokerClient.completeUploadCount, 0);
      },
    );

    test(
      'resumeUploadSessionAttachment preserves resumable metadata on local'
      ' validation failures',
      () async {
        final bytes = [1, 2, 3, 4, 5, 6];
        final hash = await sha256Digest(bytes);
        final controller = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final transferId = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          byteLength: bytes.length,
          contentHash: hash,
        );
        await controller.updateUploadState(
          id: transferId,
          uploadId: 'upload-1',
          bytesTransferred: 3,
          totalBytes: bytes.length,
        );
        final sizeResult = await worker.resumeUploadSessionAttachment(
          transferId: transferId,
          attachment: _testAttachment('resume.txt', [1, 2, 3]),
        );
        expect(sizeResult.outcome, SessionArtifactTransferWorkerOutcome.failed);
        expect(sizeResult.message, 'Upload size changed before resume.');
        expect(controller.transferById(transferId)?.attemptCount, 0);

        final sizeFailTransfer = controller.transferById(transferId);
        expect(sizeFailTransfer, isNotNull);
        expect(sizeFailTransfer!.status, SessionArtifactTransferStatus.failed);
        expect(sizeFailTransfer.uploadId, 'upload-1');
        expect(sizeFailTransfer.contentHash, hash);
        expect(sizeFailTransfer.byteLength, bytes.length);
        expect(sizeFailTransfer.bytesTransferred, 3);
        expect(sizeFailTransfer.totalBytes, bytes.length);
        expect(brokerClient.initUploadCount, 0);
        expect(brokerClient.getUploadStatusCount, 0);
        expect(brokerClient.patchOffsets, isEmpty);
        expect(brokerClient.completeUploadCount, 0);

        final hashResult = await worker.resumeUploadSessionAttachment(
          transferId: transferId,
          attachment: _testAttachment('resume.txt', [6, 5, 4, 3, 2, 1]),
        );
        expect(hashResult.outcome, SessionArtifactTransferWorkerOutcome.failed);
        expect(
          hashResult.message,
          'Upload fingerprint changed before retry.',
        );
        expect(controller.transferById(transferId)?.attemptCount, 1);
        final hashFailTransfer = controller.transferById(transferId);
        expect(hashFailTransfer, isNotNull);
        expect(hashFailTransfer!.status, SessionArtifactTransferStatus.failed);
        expect(hashFailTransfer.uploadId, 'upload-1');
        expect(hashFailTransfer.contentHash, hash);
        expect(hashFailTransfer.byteLength, bytes.length);
        expect(hashFailTransfer.bytesTransferred, 3);
        expect(hashFailTransfer.totalBytes, bytes.length);
      },
    );

    test(
      'resumeUploadSessionAttachment is single-flight and allows retry '
      'after completion',
      () async {
        final bytes = [1, 2, 3, 4, 5, 6];
        final hash = await sha256Digest(bytes);
        final controller = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final transferId = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          byteLength: bytes.length,
          contentHash: hash,
        );
        await controller.updateUploadState(
          id: transferId,
          uploadId: 'upload-1',
          bytesTransferred: 3,
          totalBytes: bytes.length,
        );
        brokerClient
          ..getUploadStatusStarted = Completer<void>()
          ..getUploadStatusContinue = Completer<void>()
          ..statusErrorCode = 'SERVER_DOWN'
          ..statusUploadId = 'upload-1'
          ..statusOffset = 3
          ..statusSize = bytes.length;

        final first = worker.resumeUploadSessionAttachment(
          transferId: transferId,
          attachment: _testAttachment('resume.txt', bytes),
        );
        await brokerClient.getUploadStatusStarted!.future;
        final second = worker.resumeUploadSessionAttachment(
          transferId: transferId,
          attachment: _testAttachment('resume.txt', bytes),
        );
        final secondResult = await second;
        expect(
          secondResult.outcome,
          SessionArtifactTransferWorkerOutcome.failed,
        );
        expect(
          secondResult.message,
          'Upload resume is already in progress for this transfer.',
        );

        brokerClient.getUploadStatusContinue!.complete();
        final firstResult = await first;
        expect(
          firstResult.outcome,
          SessionArtifactTransferWorkerOutcome.failed,
        );
        expect(firstResult.message, contains("Couldn't upload this file."));
        expect(firstResult.message, isNot(contains('upload status failed')));

        brokerClient
          ..statusErrorCode = null
          ..getUploadStatusStarted = null
          ..getUploadStatusContinue = null;
        final retried = await worker.resumeUploadSessionAttachment(
          transferId: transferId,
          attachment: _testAttachment('resume.txt', bytes),
        );
        expect(retried.outcome, SessionArtifactTransferWorkerOutcome.completed);
        expect(retried.transferId, transferId);
        expect(
          brokerClient.getUploadStatusCount,
          2,
        );
        expect(brokerClient.patchOffsets, [3]);
        expect(brokerClient.completeUploadCount, 1);
      },
    );

    test(
      'resumeUploadSessionAttachment fails safely for unrecoverable broker '
      'expiry',
      () async {
        final bytes = [1, 2, 3, 4, 5, 6];
        final hash = await sha256Digest(bytes);
        final cases = <({String code})>[
          (code: 'UPLOAD_EXPIRED'),
          (code: 'UPLOAD_NOT_FOUND'),
        ];
        const expectedMessage =
            'Upload cannot be resumed after app restart. Start a new upload '
            'from Session Detail.';

        for (final entry in cases) {
          final controller = container.read(
            sessionArtifactTransferControllerProvider.notifier,
          );
          final transferId = controller.queueUploadTransfer(
            sessionKey: sessionKey,
            brokerProfileId: 'profile-a',
            fileName: 'resume.txt',
            byteLength: 6,
            contentHash: hash,
          );
          await controller.updateUploadState(
            id: transferId,
            uploadId: 'upload-1',
            bytesTransferred: 3,
            totalBytes: 6,
          );
          brokerClient
            ..statusErrorCode = entry.code
            ..initUploadCount = 0
            ..getUploadStatusCount = 0
            ..completeUploadCount = 0
            ..patchOffsets.clear();

          final result = await worker.resumeUploadSessionAttachment(
            transferId: transferId,
            attachment: _testAttachment('resume.txt', bytes),
          );
          expect(result.outcome, SessionArtifactTransferWorkerOutcome.failed);
          expect(result.message, expectedMessage);
          expect(brokerClient.initUploadCount, 0);
          expect(brokerClient.getUploadStatusCount, 1);
          expect(brokerClient.patchOffsets, isEmpty);
          expect(brokerClient.completeUploadCount, 0);

          final preRetryTransfer = controller.transferById(transferId);
          expect(preRetryTransfer, isNotNull);
          expect(
            preRetryTransfer!.status,
            SessionArtifactTransferStatus.failed,
          );
          expect(preRetryTransfer.error, expectedMessage);
          expect(preRetryTransfer.uploadId, isNull);
          expect(preRetryTransfer.attemptCount, 0);
          expect(preRetryTransfer.contentHash, hash);
          expect(preRetryTransfer.bytesTransferred, 3);
          expect(preRetryTransfer.totalBytes, 6);
          expect(preRetryTransfer.canSelectFileToResumeUpload, isFalse);
          final preRetryRow = <String, Object?>{
            'status': preRetryTransfer.status,
            'error': preRetryTransfer.error,
            'uploadId': preRetryTransfer.uploadId,
            'attemptCount': preRetryTransfer.attemptCount,
            'contentHash': preRetryTransfer.contentHash,
            'bytesTransferred': preRetryTransfer.bytesTransferred,
            'totalBytes': preRetryTransfer.totalBytes,
            'canSelectFileToResumeUpload':
                preRetryTransfer.canSelectFileToResumeUpload,
          };

          final selectResult = await worker.selectFileToResumeUpload(
            transferId: transferId,
          );
          expect(
            selectResult.outcome,
            SessionArtifactTransferWorkerOutcome.failed,
          );
          expect(
            selectResult.message,
            'Transfer is not in a resumable state.',
          );
          final retryResult = await worker.retryTransfer(
            transferId,
            hasActiveBrokerClient: true,
          );
          expect(
            retryResult.outcome,
            SessionArtifactTransferWorkerOutcome.failed,
          );
          expect(
            retryResult.message,
            expectedMessage,
          );
          expect(brokerClient.initUploadCount, 0);
          expect(brokerClient.getUploadStatusCount, 1);
          expect(brokerClient.patchOffsets, isEmpty);
          expect(brokerClient.completeUploadCount, 0);
          final postRetryTransfer = controller.transferById(transferId);
          expect(postRetryTransfer, isNotNull);
          expect(
            <String, Object?>{
              'status': postRetryTransfer!.status,
              'error': postRetryTransfer.error,
              'uploadId': postRetryTransfer.uploadId,
              'attemptCount': postRetryTransfer.attemptCount,
              'contentHash': postRetryTransfer.contentHash,
              'bytesTransferred': postRetryTransfer.bytesTransferred,
              'totalBytes': postRetryTransfer.totalBytes,
              'canSelectFileToResumeUpload':
                  postRetryTransfer.canSelectFileToResumeUpload,
            },
            equals(preRetryRow),
          );
        }

        brokerClient.statusErrorCode = null;
      },
    );

    test(
      'resumeUploadSessionAttachment fails safely on invalid offset mismatch',
      () async {
        final bytes = [1, 2, 3, 4, 5, 6];
        final controller = container.read(
          sessionArtifactTransferControllerProvider.notifier,
        );
        final transferId = controller.queueUploadTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          fileName: 'resume.txt',
          byteLength: 6,
          contentHash: await sha256Digest(bytes),
        );
        await controller.updateUploadState(
          id: transferId,
          uploadId: 'upload-1',
          bytesTransferred: 0,
          totalBytes: 6,
        );
        brokerClient
          ..statusOffset = 0
          ..mismatchOnceAtOffset = 0
          ..expectedOffsetAfterMismatch = 99;
        final result = await worker.resumeUploadSessionAttachment(
          transferId: transferId,
          attachment: _testAttachment('resume.txt', bytes),
        );
        expect(result.outcome, SessionArtifactTransferWorkerOutcome.failed);
        expect(brokerClient.getUploadStatusCount, 1);
        expect(brokerClient.patchOffsets, [0]);
        expect(brokerClient.completeUploadCount, 0);
      },
    );

    test('retryTransfer resumes chunked upload on same row', () async {
      brokerClient.failPatchOnce = true;

      final failed = await worker.uploadSessionAttachment(
        sessionKey: sessionKey,
        attachment: _testAttachment('retry.bin', [1, 2, 3, 4, 5, 6]),
      );

      expect(failed.outcome, SessionArtifactTransferWorkerOutcome.failed);
      final transferId = failed.transferId;
      brokerClient
        ..failPatchOnce = false
        ..statusOffset = 3;

      final retried = await worker.retryTransfer(
        transferId,
        hasActiveBrokerClient: true,
      );

      expect(retried.outcome, SessionArtifactTransferWorkerOutcome.completed);
      expect(retried.transferId, transferId);
      expect(brokerClient.initUploadCount, 1);
      expect(brokerClient.getUploadStatusCount, 1);
      expect(brokerClient.patchOffsets, [0, 3]);
      final transfers = container.read(
        sessionArtifactTransferControllerProvider,
      );
      expect(transfers, hasLength(1));
      expect(transfers.single.id, transferId);
      expect(transfers.single.status, SessionArtifactTransferStatus.completed);
      expect(transfers.single.attemptCount, 1);
    });
  });
}

class _FakeBrokerClient extends BrokerClient {
  _FakeBrokerClient() : super(baseUrl: 'http://127.0.0.1:7734');

  int initUploadCount = 0;
  int getUploadStatusCount = 0;
  int completeUploadCount = 0;
  String? uploadId;
  String? initUploadId;
  int? initUploadSize;
  int initUploadOffset = 0;
  String? statusUploadId;
  int? statusSize;
  String? patchUploadId;
  int? patchUploadSize;
  bool failPatchOnce = false;
  int? mismatchOnceAtOffset;
  int expectedOffsetAfterMismatch = 0;
  int statusOffset = 0;
  final patchOffsets = <int>[];
  String? statusErrorCode;
  Completer<void>? getUploadStatusStarted;
  Completer<void>? getUploadStatusContinue;
  Completer<void>? patchUploadStarted;
  Completer<void>? patchUploadContinue;
  void Function()? onInitUpload;
  void Function()? onGetStatus;
  void Function(int offset, int byteLength)? onPatchUpload;
  UploadCompleteResult completeResult = const UploadCompleteResult(
    uploadId: 'upload-1',
    stagedRef: 'stg1.uploaded',
    name: 'uploaded.bin',
    mimeType: '',
    size: 6,
    expiresAt: 1783590000000,
  );

  @override
  Future<UploadInitResult> initUpload(
    String tool,
    String id, {
    required String name,
    String? mimeType,
    int? size,
    String? contentHash,
  }) async {
    initUploadCount++;
    onInitUpload?.call();
    final initUploadId = this.initUploadId ?? uploadId ?? 'upload-1';
    final initUploadSize = this.initUploadSize ?? size ?? 0;
    return UploadInitResult(
      uploadId: initUploadId,
      offset: initUploadOffset,
      size: initUploadSize,
      expiresAt: 1783590000000,
    );
  }

  @override
  Future<UploadStatus> getUploadStatus(
    String tool,
    String id,
    String uploadId,
  ) async {
    getUploadStatusCount++;
    if (getUploadStatusStarted != null &&
        !getUploadStatusStarted!.isCompleted) {
      getUploadStatusStarted!.complete();
    }
    onGetStatus?.call();
    if (getUploadStatusContinue != null) {
      await getUploadStatusContinue!.future;
    }
    if (statusErrorCode != null) {
      throw BrokerException(
        message: 'upload status failed',
        error: BrokerError(error: statusErrorCode!, code: statusErrorCode),
      );
    }
    final statusUploadId = this.statusUploadId ?? uploadId;
    final statusSize = this.statusSize ?? completeResult.size;
    return UploadStatus(
      uploadId: statusUploadId,
      offset: statusOffset,
      size: statusSize,
      name: completeResult.name,
      mimeType: completeResult.mimeType,
      expiresAt: completeResult.expiresAt,
      ready: statusOffset == statusSize,
    );
  }

  @override
  Future<UploadPatchResult> patchUploadChunk(
    String tool,
    String id,
    String uploadId, {
    required int offset,
    required List<int> bytes,
  }) async {
    patchOffsets.add(offset);
    if (patchUploadStarted != null && !patchUploadStarted!.isCompleted) {
      patchUploadStarted!.complete();
    }
    onPatchUpload?.call(offset, bytes.length);
    if (patchUploadContinue != null) {
      await patchUploadContinue!.future;
    }
    if (failPatchOnce) {
      failPatchOnce = false;
      throw const BrokerException(message: 'network failed');
    }
    if (mismatchOnceAtOffset == offset) {
      mismatchOnceAtOffset = null;
      throw UploadOffsetMismatchException(
        expectedOffset: expectedOffsetAfterMismatch,
        statusCode: 409,
        error: const BrokerError(
          error: 'Offset mismatch',
          code: 'UPLOAD_OFFSET_MISMATCH',
        ),
      );
    }
    final patchUploadId = this.patchUploadId ?? uploadId;
    final patchUploadSize = this.patchUploadSize ?? completeResult.size;
    return UploadPatchResult(
      uploadId: patchUploadId,
      offset: offset + bytes.length,
      size: patchUploadSize,
      progress: completeResult.size == 0
          ? 1
          : (offset + bytes.length) / completeResult.size,
    );
  }

  @override
  Future<UploadCompleteResult> completeUpload(
    String tool,
    String id,
    String uploadId,
  ) async {
    completeUploadCount++;
    return completeResult;
  }
}

class _FakeSessionAttachmentPicker implements SessionAttachmentPicker {
  _FakeSessionAttachmentPicker({
    this.nextAttachment,
    this.onPick,
  });

  final SessionAttachment? nextAttachment;
  final Future<SessionAttachment?> Function()? onPick;

  int pickCallCount = 0;

  @override
  Future<List<SessionAttachment>> pickAttachments({
    bool allowMultiple = true,
  }) async {
    pickCallCount += 1;
    if (onPick != null) {
      final picked = await onPick!();
      return picked == null ? const [] : [picked];
    }
    return nextAttachment == null ? const [] : [nextAttachment!];
  }
}

class _RecordingSessionArtifactTransferRepository
    implements SessionArtifactTransferRepository {
  _RecordingSessionArtifactTransferRepository();

  final List<SessionArtifactTransfer> _transfers = [];
  Duration Function(SessionArtifactTransfer transfer)? upsertDelay;

  SessionArtifactTransfer? get latestUploadTransfer {
    for (final transfer in _transfers.reversed) {
      if (transfer.direction == SessionArtifactTransferDirection.upload) {
        return transfer;
      }
    }
    return null;
  }

  @override
  Future<List<SessionArtifactTransfer>> loadTransfers() async {
    return List.unmodifiable(_transfers);
  }

  @override
  Future<void> upsertTransfer(SessionArtifactTransfer transfer) async {
    final delay = upsertDelay?.call(transfer);
    if (delay != null && delay > Duration.zero) {
      await Future<void>.delayed(delay);
    }
    final index = _transfers.indexWhere((item) => item.id == transfer.id);
    if (index < 0) {
      _transfers.insert(0, transfer);
    } else {
      _transfers[index] = transfer;
    }
  }

  @override
  Future<void> deleteTerminalTransfers() async {}
}

class _FakeSessionArtifactFileService implements SessionArtifactFileService {
  SessionArtifactCachedFile? mockCachedFile;
  Completer<void>? cacheStarted;
  Completer<SessionArtifactCachedFile>? cacheCompleter;
  List<({int bytesTransferred, int? totalBytes})> progressSteps = const [];
  int cacheCallCount = 0;
  int sessionFileCacheCallCount = 0;
  int exportCallCount = 0;
  String? exportedPath;
  String? lastSessionFilePath;

  @override
  Future<SessionArtifactCachedFile> cacheArtifact(
    SessionArtifactDescriptor descriptor, {
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) async {
    cacheCallCount++;
    for (final step in progressSteps) {
      onProgress?.call(
        bytesTransferred: step.bytesTransferred,
        totalBytes: step.totalBytes,
      );
    }
    final completer = cacheCompleter;
    if (completer != null) {
      cacheStarted?.complete();
      return completer.future;
    }
    return mockCachedFile ??
        SessionArtifactCachedFile(
          cachedFilePath: descriptor.name ?? 'artifact.bin',
          fileName: descriptor.name ?? 'artifact.bin',
          byteLength: 0,
        );
  }

  @override
  Future<SessionArtifactCachedFile> cacheSessionFile({
    required String tool,
    required String sessionId,
    required String path,
    required String fileName,
    String? mimeType,
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) async {
    sessionFileCacheCallCount++;
    lastSessionFilePath = path;
    return SessionArtifactCachedFile(
      cachedFilePath: fileName,
      fileName: fileName,
      contentType: mimeType,
      byteLength: 0,
    );
  }

  @override
  Future<String?> exportCachedArtifact(
    SessionArtifactCachedFile artifact, {
    SessionArtifactCancellationToken? cancellationToken,
  }) async {
    exportCallCount++;
    return exportedPath;
  }
}
