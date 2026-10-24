import 'dart:async';
import 'dart:io';

import 'package:broker_client/broker_client.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/feature/fake_file_downloads.dart';

void main() {
  group('SessionFileBackgroundDownloadCoordinator', () {
    const sessionKey = SessionDetailKey(tool: 'claude', sessionId: 'session-1');
    const cachedFile = SessionArtifactCachedFile(
      cachedFilePath: '/cache/report.txt',
      fileName: 'report.txt',
      contentType: 'text/plain',
      byteLength: 128,
    );

    late ProviderContainer container;
    late SessionArtifactTransferController controller;

    setUp(() {
      container = ProviderContainer(
        overrides: [
          sessionArtifactTransferRepositoryProvider.overrideWithValue(
            InMemorySessionArtifactTransferRepository(),
          ),
        ],
      );
      controller = container.read(
        sessionArtifactTransferControllerProvider.notifier,
      );
    });

    tearDown(() => container.dispose());

    BrokerClient brokerClient() => BrokerClient(
      baseUrl: 'http://127.0.0.1:7734',
      peerToken: 'peer-secret',
    );

    final hubs =
        <FakeBackgroundDownloadEngine, SessionFileBackgroundUpdateHub>{};
    SessionFileBackgroundUpdateHub hubFor(
      FakeBackgroundDownloadEngine engine,
    ) => hubs.putIfAbsent(engine, () {
      final hub = SessionFileBackgroundUpdateHub(engine);
      addTearDown(hub.dispose);
      return hub;
    });

    SessionFileBackgroundDownloadCoordinator coordinatorWith(
      FakeBackgroundDownloadEngine engine, {
      String? brokerProfileId = 'profile-a',
      _FakeFinalizer? finalizer,
      bool withoutClient = false,
    }) {
      return SessionFileBackgroundDownloadCoordinator(
        hub: hubFor(engine),
        transferController: controller,
        finalizer: finalizer ?? _FakeFinalizer(cachedFile),
        brokerProfileId: brokerProfileId,
        // `?? brokerClient()` would silently replace an intended null client,
        // so absence is an explicit flag rather than a nullable parameter.
        brokerClient: withoutClient ? null : brokerClient(),
      );
    }

    SessionArtifactTransferWorker workerWith(
      SessionFileBackgroundDownloadCoordinator coordinator, {
      String? brokerProfileId = 'profile-a',
    }) {
      return SessionArtifactTransferWorker(
        brokerProfileId: brokerProfileId,
        fileService: _UnusedFileService(),
        transferController: controller,
        backgroundCoordinator: coordinator,
      );
    }

    // These controlled startup/database races cannot be driven through a UI
    // tap: the native tracking write and startup completion are independent.
    test(
      'replacement uses live completion over a stale running record',
      () async {
        final engine = FakeBackgroundDownloadEngine();
        final first = coordinatorWith(engine);
        final result = await workerWith(first).downloadSessionFile(
          sessionKey: sessionKey,
          path: 'notes/report.txt',
          fileName: 'report.txt',
          hasActiveBrokerClient: true,
        );
        await first.dispose();
        engine
          ..records = [
            BackgroundDownloadRecord(
              taskId: result.transferId,
              status: BackgroundDownloadTaskStatus.running,
            ),
          ]
          ..emit(
            BackgroundDownloadRecord(
              taskId: result.transferId,
              status: BackgroundDownloadTaskStatus.complete,
              filePath: '/native/tmp/report.part',
            ),
          );
        await pumpEventQueue();
        final replacement = coordinatorWith(engine);
        addTearDown(replacement.dispose);
        await replacement.bootstrap();
        expect(
          controller.transferById(result.transferId)!.status,
          SessionArtifactTransferStatus.cached,
        );
      },
    );

    test(
      'disposal during startup leaves native listener with the hub',
      () async {
        final engine = FakeBackgroundDownloadEngine()
          ..startup = Completer<void>();
        final first = coordinatorWith(engine);
        final starting = first.bootstrap();
        await first.dispose();
        final replacement = coordinatorWith(engine);
        addTearDown(replacement.dispose);
        final restarting = replacement.bootstrap();
        engine.startup!.complete();
        await Future.wait([starting, restarting]);
        final result = await workerWith(replacement).downloadSessionFile(
          sessionKey: sessionKey,
          path: 'notes/report.txt',
          fileName: 'report.txt',
          hasActiveBrokerClient: true,
        );
        engine.emit(
          BackgroundDownloadRecord(
            taskId: result.transferId,
            status: BackgroundDownloadTaskStatus.running,
            bytesTransferred: 64,
            totalBytes: 128,
          ),
        );
        await pumpEventQueue();
        expect(
          controller.transferById(result.transferId)!.bytesTransferred,
          64,
        );
      },
    );

    test(
      'a transient ledger load failure still reconciles a native completion',
      () async {
        final repository = _TransientLoadRepository();
        final now = DateTime.now();
        const id = 'restart-task';
        await repository.upsertTransfer(
          SessionArtifactTransfer(
            id: id,
            sessionKey: sessionKey,
            actionKey: 'report',
            fileName: 'report.txt',
            direction: SessionArtifactTransferDirection.download,
            status: SessionArtifactTransferStatus.queued,
            brokerProfileId: 'profile-a',
            createdAt: now,
            updatedAt: now,
          ),
        );
        final restarted = ProviderContainer(
          overrides: [
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              repository,
            ),
          ],
        );
        addTearDown(restarted.dispose);
        final engine = FakeBackgroundDownloadEngine()
          ..records = [
            const BackgroundDownloadRecord(
              taskId: id,
              status: BackgroundDownloadTaskStatus.complete,
              filePath: '/native/report.part',
            ),
          ];
        final coordinator = SessionFileBackgroundDownloadCoordinator(
          hub: hubFor(engine),
          transferController: restarted.read(
            sessionArtifactTransferControllerProvider.notifier,
          ),
          finalizer: _FakeFinalizer(cachedFile),
          brokerProfileId: 'profile-a',
          brokerClient: brokerClient(),
        );
        addTearDown(coordinator.dispose);
        await coordinator.bootstrap();
        expect(repository.loads, 2);
        expect(
          restarted
              .read(sessionArtifactTransferControllerProvider)
              .single
              .status,
          SessionArtifactTransferStatus.cached,
        );
      },
    );

    test(
      'downloadSessionFile enqueues a native task with auth headers and '
      'marks the ledger running',
      () async {
        final engine = FakeBackgroundDownloadEngine();
        final worker = workerWith(coordinatorWith(engine));

        final result = await worker.downloadSessionFile(
          sessionKey: sessionKey,
          path: 'notes/report.txt',
          fileName: 'report.txt',
          mimeType: 'text/plain',
          hasActiveBrokerClient: true,
        );

        expect(
          result.outcome,
          SessionArtifactTransferWorkerOutcome.enqueuedInBackground,
        );
        expect(result.succeeded, isTrue);
        expect(engine.started, isTrue);
        expect(engine.enqueued, hasLength(1));
        final request = engine.enqueued.single;
        expect(request.taskId, result.transferId);
        // Broker auth header is present on the created task (invariant 3).
        expect(request.headers['x-cosyncing-peer-token'], 'peer-secret');
        expect(
          request.url,
          'http://127.0.0.1:7734/api/sessions/claude/session-1/fs/download'
          '?path=notes%2Freport.txt',
        );

        final transfer = controller.transferById(result.transferId)!;
        expect(transfer.status, SessionArtifactTransferStatus.running);
        expect(transfer.brokerProfileId, 'profile-a');
      },
    );

    test(
      'live updates drive queued -> running -> complete with ledger '
      'reconciliation and finalization',
      () async {
        final engine = FakeBackgroundDownloadEngine();
        final finalizer = _FakeFinalizer(cachedFile);
        final worker = workerWith(
          coordinatorWith(engine, finalizer: finalizer),
        );

        final result = await worker.downloadSessionFile(
          sessionKey: sessionKey,
          path: 'notes/report.txt',
          fileName: 'report.txt',
          mimeType: 'text/plain',
          hasActiveBrokerClient: true,
        );
        final id = result.transferId;

        engine
          ..emit(
            const BackgroundDownloadRecord(
              taskId: 'claude:session-1:...',
              status: BackgroundDownloadTaskStatus.running,
            ),
          )
          ..emit(
            BackgroundDownloadRecord(
              taskId: id,
              status: BackgroundDownloadTaskStatus.running,
              bytesTransferred: 64,
              totalBytes: 128,
            ),
          );
        await pumpEventQueue();
        final running = controller.transferById(id)!;
        expect(running.status, SessionArtifactTransferStatus.running);
        expect(running.bytesTransferred, 64);
        expect(running.totalBytes, 128);

        engine.emit(
          BackgroundDownloadRecord(
            taskId: id,
            status: BackgroundDownloadTaskStatus.complete,
            filePath: '/native/tmp/report.part',
            mimeType: 'text/plain',
          ),
        );
        await pumpEventQueue();

        final done = controller.transferById(id)!;
        expect(done.status, SessionArtifactTransferStatus.cached);
        expect(done.cachedFilePath, '/cache/report.txt');
        expect(done.partialFilePath, isNull); // checkpoint cleared
        expect(finalizer.calls, 1);
        expect(finalizer.lastDownloadedPath, '/native/tmp/report.part');
        expect(finalizer.lastMimeType, 'text/plain');
        expect(engine.forgotten, contains(id));
      },
    );

    test(
      'a fresh worker finalizes a task that completed while the app was gone',
      () async {
        // Simulate a durable row hydrated after restart (queued), owned by the
        // active profile.
        final id = controller.queueTransfer(
          sessionKey: sessionKey,
          brokerProfileId: 'profile-a',
          descriptor: const SessionArtifactDescriptor(
            name: 'report.txt',
            fetchUrl: 'session-file:notes%2Freport.txt',
          ),
          direction: SessionArtifactTransferDirection.download,
        );
        final finalizer = _FakeFinalizer(cachedFile);
        final engine = FakeBackgroundDownloadEngine()
          ..records = [
            BackgroundDownloadRecord(
              taskId: id,
              status: BackgroundDownloadTaskStatus.complete,
              filePath: '/native/tmp/report.part',
              mimeType: 'text/plain',
            ),
          ];
        final coordinator = coordinatorWith(engine, finalizer: finalizer);

        await coordinator.reconcile();

        final done = controller.transferById(id)!;
        expect(done.status, SessionArtifactTransferStatus.cached);
        expect(done.cachedFilePath, '/cache/report.txt');
        expect(finalizer.calls, 1);
        expect(engine.forgotten, contains(id));
      },
    );

    test('a task owned by another broker profile is not reconciled', () async {
      final id = controller.queueTransfer(
        sessionKey: sessionKey,
        brokerProfileId: 'profile-b',
        descriptor: const SessionArtifactDescriptor(
          name: 'report.txt',
          fetchUrl: 'session-file:notes%2Freport.txt',
        ),
        direction: SessionArtifactTransferDirection.download,
      );
      final finalizer = _FakeFinalizer(cachedFile);
      final engine = FakeBackgroundDownloadEngine()
        ..records = [
          BackgroundDownloadRecord(
            taskId: id,
            status: BackgroundDownloadTaskStatus.complete,
            filePath: '/native/tmp/report.part',
          ),
        ];
      // Active profile is profile-a; the row belongs to profile-b.
      final coordinator = coordinatorWith(engine, finalizer: finalizer);

      await coordinator.reconcile();

      final untouched = controller.transferById(id)!;
      expect(untouched.status, SessionArtifactTransferStatus.queued);
      expect(untouched.cachedFilePath, isNull);
      expect(finalizer.calls, 0);
      expect(engine.forgotten, isEmpty);
    });

    test('cancel propagates to the native task and cancels the row', () async {
      final engine = FakeBackgroundDownloadEngine();
      final finalizer = _FakeFinalizer(cachedFile);
      final worker = workerWith(coordinatorWith(engine, finalizer: finalizer));
      final result = await worker.downloadSessionFile(
        sessionKey: sessionKey,
        path: 'notes/report.txt',
        fileName: 'report.txt',
        hasActiveBrokerClient: true,
      );
      final id = result.transferId;

      worker.cancelTransfer(id);
      await pumpEventQueue();

      expect(engine.canceled, contains(id));
      expect(
        controller.transferById(id)!.status,
        SessionArtifactTransferStatus.canceled,
      );

      // A late completion for a canceled row must not resurrect/finalize it.
      engine.emit(
        BackgroundDownloadRecord(
          taskId: id,
          status: BackgroundDownloadTaskStatus.complete,
          filePath: '/native/tmp/report.part',
        ),
      );
      await pumpEventQueue();
      expect(
        controller.transferById(id)!.status,
        SessionArtifactTransferStatus.canceled,
      );
      expect(finalizer.calls, 0);
    });

    test('a live-update finalize error fails the row, not the zone', () async {
      final engine = FakeBackgroundDownloadEngine();
      final finalizer = _FakeFinalizer(cachedFile)..throwOnFinalize = true;
      final worker = workerWith(coordinatorWith(engine, finalizer: finalizer));
      final result = await worker.downloadSessionFile(
        sessionKey: sessionKey,
        path: 'notes/report.txt',
        fileName: 'report.txt',
        hasActiveBrokerClient: true,
      );
      final id = result.transferId;

      engine.emit(
        BackgroundDownloadRecord(
          taskId: id,
          status: BackgroundDownloadTaskStatus.complete,
          filePath: '/native/tmp/report.part',
        ),
      );
      await pumpEventQueue();

      // Contained: the owned row settles failed instead of staying pinned
      // running behind an unhandled async error until the next restart.
      expect(finalizer.calls, 1);
      expect(
        controller.transferById(id)!.status,
        SessionArtifactTransferStatus.failed,
      );
    });

    test('a rejected enqueue fails the ledger row', () async {
      final engine = FakeBackgroundDownloadEngine()..enqueueAccepted = false;
      final worker = workerWith(coordinatorWith(engine));

      final result = await worker.downloadSessionFile(
        sessionKey: sessionKey,
        path: 'notes/report.txt',
        fileName: 'report.txt',
        hasActiveBrokerClient: true,
      );

      expect(result.outcome, SessionArtifactTransferWorkerOutcome.failed);
      expect(
        controller.transferById(result.transferId)!.status,
        SessionArtifactTransferStatus.failed,
      );
    });

    test('no active broker client fails before touching the engine', () async {
      final engine = FakeBackgroundDownloadEngine();
      final worker = workerWith(coordinatorWith(engine, withoutClient: true));

      final result = await worker.downloadSessionFile(
        sessionKey: sessionKey,
        path: 'notes/report.txt',
        fileName: 'report.txt',
        hasActiveBrokerClient: false,
      );

      expect(result.outcome, SessionArtifactTransferWorkerOutcome.failed);
      expect(engine.started, isFalse);
      expect(engine.enqueued, isEmpty);
      expect(
        controller.transferById(result.transferId)!.status,
        SessionArtifactTransferStatus.failed,
      );
    });
  });
}

class _FakeFinalizer implements BackgroundSessionDownloadFinalizer {
  _FakeFinalizer(this.result);

  final SessionArtifactCachedFile result;
  int calls = 0;
  bool throwOnFinalize = false;
  String? lastDownloadedPath;
  String? lastMimeType;

  @override
  String get backgroundDownloadSubdirectory => sessionArtifactCacheSubdirectory;

  @override
  Future<SessionArtifactCachedFile> finalizeBackgroundDownload({
    required String downloadedFilePath,
    required String fileName,
    String? mimeType,
  }) async {
    calls += 1;
    if (throwOnFinalize) {
      throw const FileSystemException('finalize failed');
    }
    lastDownloadedPath = downloadedFilePath;
    lastMimeType = mimeType;
    return result;
  }
}

class _UnusedFileService implements SessionArtifactFileService {
  @override
  Future<SessionArtifactCachedFile> cacheArtifact(
    SessionArtifactDescriptor descriptor, {
    SessionFileDownloadCheckpoint? checkpoint,
    SessionFileDownloadCheckpointCallback? onCheckpoint,
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) => throw UnimplementedError(
    'foreground path not used in background tests',
  );

  @override
  Future<SessionArtifactCachedFile> cacheSessionFile({
    required String tool,
    required String sessionId,
    required String path,
    required String fileName,
    String? mimeType,
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) => throw UnimplementedError(
    'foreground path not used in background tests',
  );

  @override
  Future<ArtifactExportResult?> exportCachedArtifact(
    SessionArtifactCachedFile artifact, {
    String? suggestedName,
    SessionArtifactCancellationToken? cancellationToken,
  }) => throw UnimplementedError(
    'foreground path not used in background tests',
  );
}

class _TransientLoadRepository
    extends InMemorySessionArtifactTransferRepository {
  int loads = 0;
  @override
  Future<List<SessionArtifactTransfer>> loadTransfers() async {
    if (++loads == 1) throw StateError('temporary ledger read failure');
    return super.loadTransfers();
  }
}
