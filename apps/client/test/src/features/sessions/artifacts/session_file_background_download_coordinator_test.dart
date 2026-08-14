import 'dart:async';
import 'dart:io';

import 'package:broker_client/broker_client.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

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

    SessionFileBackgroundDownloadCoordinator coordinatorWith(
      _FakeBackgroundEngine engine, {
      String? brokerProfileId = 'profile-a',
      _FakeFinalizer? finalizer,
      bool withoutClient = false,
    }) {
      return SessionFileBackgroundDownloadCoordinator(
        engine: engine,
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

    test(
      'downloadSessionFile enqueues a native task with auth headers and '
      'marks the ledger running',
      () async {
        final engine = _FakeBackgroundEngine();
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
        final engine = _FakeBackgroundEngine();
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
        final engine = _FakeBackgroundEngine()
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
      final engine = _FakeBackgroundEngine()
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
      final engine = _FakeBackgroundEngine();
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
      final engine = _FakeBackgroundEngine();
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
      final engine = _FakeBackgroundEngine()..enqueueAccepted = false;
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
      final engine = _FakeBackgroundEngine();
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

class _FakeBackgroundEngine implements SessionFileBackgroundDownloader {
  bool started = false;
  bool enqueueAccepted = true;
  final enqueued = <BackgroundSessionDownloadRequest>[];
  final canceled = <String>[];
  final forgotten = <String>[];
  List<BackgroundDownloadRecord> records = const [];
  final _updates = StreamController<BackgroundDownloadRecord>.broadcast();

  void emit(BackgroundDownloadRecord record) => _updates.add(record);

  @override
  bool get isSupported => true;

  @override
  Future<void> ensureStarted() async {
    started = true;
  }

  @override
  Future<bool> enqueue(BackgroundSessionDownloadRequest request) async {
    enqueued.add(request);
    return enqueueAccepted;
  }

  @override
  Future<List<BackgroundDownloadRecord>> loadRecords() async => records;

  @override
  Future<BackgroundDownloadRecord?> recordFor(String taskId) async {
    for (final record in records) {
      if (record.taskId == taskId) return record;
    }
    return null;
  }

  @override
  Future<void> cancel(String taskId) async => canceled.add(taskId);

  @override
  Future<void> forget(String taskId) async => forgotten.add(taskId);

  @override
  Stream<BackgroundDownloadRecord> updates() => _updates.stream;
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
  Future<String?> exportCachedArtifact(
    SessionArtifactCachedFile artifact, {
    SessionArtifactCancellationToken? cancellationToken,
  }) => throw UnimplementedError(
    'foreground path not used in background tests',
  );
}
