import 'dart:async';
import 'dart:io';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/design/components/contextual_details.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/background_downloader_engine.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_file_service.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_transfer.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_transfer_worker.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_file_background_download.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_file_browser.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/transfers/view/cached_transfer_actions.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';

import '../support/feature/app_driver.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/fake_file_downloads.dart';
import '../support/feature/roster_driver.dart';
import '../support/feature/transcript_wire.dart';

void main() {
  for (final scenario in [
    'server switch',
    'paused',
    'paused on other server',
    'foreground on other server',
    'save queue',
    'simultaneous completion',
    'queued save loses foreground',
    'restart',
    'cancel',
    'write failure',
    'share',
  ]) {
    featureTest('Android workspace download: $scenario', (f) async {
      final directory = Directory.systemTemp.createTempSync(
        'download-feature-',
      );
      final previousPaths = PathProviderPlatform.instance;
      PathProviderPlatform.instance = DownloadTemporaryPaths(directory.path);
      final native = FakeDownloadTrackingDatabase();
      final save = FakeAndroidSaveAs()..install();
      final shares = <SessionArtifactCachedFile>[];
      Exception? shareFailure;
      addTearDown(() {
        PathProviderPlatform.instance = previousPaths;
        if (directory.existsSync()) directory.deleteSync(recursive: true);
      });
      final broker = f.network.add('http://studio.test:7734')
        ..addSession('s1', 'File download');
      final firstProfile = await f.storage.seedServer(broker);
      final other = f.network.add('http://other.test:7734')
        ..addSession('s1', 'Other files');
      final otherProfile = await f.storage.seedServer(other, active: false);
      var app = await f.launch(
        viewport: FeatureViewport.phone,
        overrides: [
          sessionFileBackgroundDownloaderProvider.overrideWith((ref) {
            final engine = native.launch();
            ref.onDispose(engine.dispose);
            return engine;
          }),
          sessionFileBrowserRepositoryProvider.overrideWith(
            (ref) async => _DownloadWorkspace(),
          ),
          cachedFileShareProvider.overrideWithValue((file) async {
            final failure = shareFailure;
            if (failure != null) throw failure;
            shares.add(file);
          }),
        ],
      );
      if (scenario == 'server switch') {
        // A previous transfer creates the worker before the server changes.
        app.container.read(sessionArtifactTransferWorkerProvider);
        await app.tapKey('workspace-open-drawer');
        await app.switchServer(otherProfile.id);
      } else {
        await app.tapKey('workspace-open-drawer');
      }
      await app.openFromRoster('s1', cwd: '/work/studio');
      await app.tapKey('session-detail-view-menu');
      await app.tapKey('session-detail-view-item-files');
      await app.tapKey('session-detail-files-download-审阅意见.md');
      final engine = native.launches.single;
      expect(engine.enqueued, hasLength(1));
      final id = engine.enqueued.single.taskId;
      String? secondId;
      if (scenario == 'simultaneous completion' ||
          scenario == 'queued save loses foreground') {
        await app.tapKey('session-detail-files-download-审阅意见.md');
        secondId = engine.enqueued.last.taskId;
        expect(secondId, isNot(id));
        save.pending = Completer<void>();
      }
      final controller = app.container.read(
        sessionArtifactTransferControllerProvider.notifier,
      );
      engine.emit(
        BackgroundDownloadRecord(
          taskId: id,
          status: BackgroundDownloadTaskStatus.running,
          bytesTransferred: 8,
          totalBytes: 16,
        ),
      );
      await app.pumpUntil(
        () => controller.transferById(id)?.bytesTransferred == 8,
        reason: 'native progress survives worker replacement',
      );
      expect(engine.listens, 1);
      if (scenario == 'server switch') {
        // The save intent and latest progress also survive replacement while
        // the native task itself is still running.
        await app.tapKey('workspace-open-drawer');
        await app.switchServer(firstProfile.id);
        await app.switchServer(otherProfile.id);
        await app.openFromRoster('s1', cwd: '/work/studio');
        expect(engine.listens, 1);
      }
      if (scenario == 'cancel') save.response = null;
      if (scenario == 'write failure') {
        save.error = PlatformException(
          code: 'write_failed',
          message: 'Document provider refused the write',
        );
      }
      if (scenario == 'paused on other server' ||
          scenario == 'foreground on other server') {
        await app.tapKey('workspace-open-drawer');
        await app.switchServer(otherProfile.id);
      }
      if (scenario == 'paused' ||
          scenario == 'share' ||
          scenario == 'save queue' ||
          scenario == 'paused on other server') {
        app.tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.paused,
        );
        await app.settle();
      }
      final staged = stageNativeDownload(directory, id);
      if (scenario == 'restart') {
        // Persist the row and exit before the native OS task finishes.
        await controller.persistTransfer(id);
        await f.quit();
        native.complete(id, staged);
        app = await f.restart();
      } else {
        native.complete(id, staged);
      }
      if (secondId != null) {
        if (scenario == 'queued save loses foreground') {
          // Gate the first picker explicitly: cache finalization is allowed
          // to finish out of download order when the completions overlap.
          await _nativeUntil(app, () => save.requests.length == 1);
        }
        native.complete(
          secondId,
          stageNativeDownload(
            directory,
            secondId,
            contents: 'other file bytes',
          ),
        );
        await _nativeUntil(
          app,
          () =>
              save.requests.length == 1 &&
              _row(app, secondId!)?.status ==
                  SessionArtifactTransferStatus.cached &&
              engine.forgotten.contains(secondId),
        );
        expect(save.requests, hasLength(1));
        if (scenario == 'queued save loses foreground') {
          app.tester.binding.handleAppLifecycleStateChanged(
            AppLifecycleState.paused,
          );
          await app.settle();
        }
        save.pending!.complete();
        save.pending = null;
        if (scenario == 'simultaneous completion') {
          await _nativeUntil(
            app,
            () =>
                _row(app, secondId!)?.status ==
                SessionArtifactTransferStatus.completed,
          );
          expect(save.requests, hasLength(2));
        } else {
          try {
            await _nativeUntil(
              app,
              () =>
                  _row(app, id)?.status ==
                  SessionArtifactTransferStatus.completed,
            );
          } finally {
            // Restore frame delivery even on assertion failure, so fixture
            // teardown can unmount before disposing its ProviderContainer.
            for (final state in [
              AppLifecycleState.hidden,
              AppLifecycleState.inactive,
              AppLifecycleState.resumed,
            ]) {
              app.tester.binding.handleAppLifecycleStateChanged(state);
            }
          }
          await app.settle();
          expect(save.requests, hasLength(1));
          expect(
            _row(app, secondId)!.status,
            SessionArtifactTransferStatus.cached,
          );
        }
        final firstPath = _row(app, id)!.cachedFilePath!;
        final secondPath = _row(app, secondId)!.cachedFilePath!;
        expect(secondPath, isNot(firstPath));
        expect(File(firstPath).readAsStringSync(), 'download fixture');
        expect(File(secondPath).readAsStringSync(), 'other file bytes');
      }
      if (scenario == 'paused on other server' ||
          scenario == 'foreground on other server') {
        await app.settle();
        expect(save.requests, isEmpty);
        if (scenario == 'paused on other server') {
          for (final state in [
            AppLifecycleState.hidden,
            AppLifecycleState.inactive,
            AppLifecycleState.resumed,
          ]) {
            app.tester.binding.handleAppLifecycleStateChanged(state);
          }
        }
        await app.switchServer(firstProfile.id);
        await app.openFromRoster('s1', cwd: '/work/studio');
      }
      final expected = switch (scenario) {
        'paused' ||
        'paused on other server' ||
        'foreground on other server' ||
        'save queue' ||
        'share' ||
        'restart' => SessionArtifactTransferStatus.cached,
        'cancel' => SessionArtifactTransferStatus.canceled,
        'write failure' => SessionArtifactTransferStatus.failed,
        _ => SessionArtifactTransferStatus.completed,
      };
      await _nativeUntil(app, () => _row(app, id)?.status == expected);
      final cached = _row(app, id)!.cachedFilePath!;
      expect(File(cached).existsSync(), isTrue);
      if (scenario == 'paused' ||
          scenario == 'share' ||
          scenario == 'save queue') {
        expect(save.requests, isEmpty);
        for (final state in [
          AppLifecycleState.hidden,
          AppLifecycleState.inactive,
          AppLifecycleState.resumed,
        ]) {
          app.tester.binding.handleAppLifecycleStateChanged(state);
        }
        await app.settle();
        expect(
          save.requests,
          isEmpty,
          reason: 'resuming never opens a deferred picker',
        );
      }
      await app.go(transfersRoute);
      if (scenario == 'paused' ||
          scenario == 'paused on other server' ||
          scenario == 'foreground on other server' ||
          scenario == 'save queue' ||
          scenario == 'restart' ||
          scenario == 'share') {
        expect(save.requests, isEmpty);
        expect(find.textContaining('Downloaded'), findsWidgets);
        if (scenario == 'paused') {
          await app.enterText(
            find.byKey(const Key('transfer-manager-search-field')),
            'Downloaded',
          );
          expect(find.text('Download: 审阅意见.md'), findsOneWidget);
          await app.tapKey('transfer-manager-search-clear');
        }
      } else {
        expect(save.requests.first['suggestedName'], '审阅意见.md');
        expect(save.requests.first['mimeType'], 'text/markdown');
      }
      expect(find.byKey(Key('transfer-manager-save-$id')), findsOneWidget);
      expect(find.byKey(Key('transfer-manager-share-$id')), findsOneWidget);
      if (scenario == 'paused') {
        save.response = null;
        await app.tapKey('transfer-manager-save-$id');
        expect(_row(app, id)!.status, SessionArtifactTransferStatus.cached);
      }
      if (scenario == 'paused' || scenario == 'cancel') {
        save.response = {
          'uri': 'content://documents/saved/审阅意见.md',
          'displayName': '审阅意见.md',
        };
        await app.tapKey('transfer-manager-save-$id');
        await _nativeUntil(
          app,
          () =>
              _row(app, id)?.status == SessionArtifactTransferStatus.completed,
        );
        expect(find.textContaining('Saved'), findsWidgets);
        if (scenario == 'paused') {
          await app.enterText(
            find.byKey(const Key('transfer-manager-search-field')),
            'Saved',
          );
          expect(find.text('Download: 审阅意见.md'), findsOneWidget);
          await app.tapKey('transfer-manager-search-clear');
        }
      }
      if (scenario == 'share') {
        await app.tapKey('transfer-manager-share-$id');
        await app.pumpUntil(
          () => shares.isNotEmpty,
          reason: 'native share sheet receives the cached file',
        );
        expect(shares.single.cachedFilePath, cached);
        expect(shares.single.fileName, '审阅意见.md');
        expect(shares.single.contentType, 'text/markdown');
        expect(_row(app, id)!.status, expected);
        shareFailure = Exception(
          'https://share.test/file?token=fixture-secret '.padRight(10000, 'x'),
        );
        await app.tapKey('transfer-manager-share-$id');
        await app.tap(find.widgetWithText(SnackBarAction, 'Technical details'));
        final detail = app.tester
            .widget<SelectableText>(
              find.byKey(const Key('contextual-details-text')),
            )
            .data!;
        expect(detail, isNot(contains('fixture-secret')));
        // The copied snapshot prefixes timestamp and filename; the shared
        // error bound applies to the diagnostic payload after those headers.
        final payload = detail.split('\n').skip(2).join('\n');
        expect(payload.length, lessThanOrEqualTo(maxTechnicalDetailLength));
        expect(payload, endsWith('…'));
        await app.tapKey('contextual-details-close');
        File(cached).deleteSync();
        await app.tapKey('transfer-manager-save-$id');
        expect(
          find.text('The cached copy was removed. Download the file again.'),
          findsOneWidget,
        );
        expect(_row(app, id)!.status, SessionArtifactTransferStatus.cached);
      }
      if (scenario == 'save queue') {
        // Two explicit saves cross a reconnect-bound worker replacement. The
        // native fake rejects concurrent calls exactly like Android does.
        save.pending = Completer<void>();
        await app.tapKey('transfer-manager-save-$id');
        await _nativeUntil(app, () => save.requests.length == 1);
        app.container.invalidate(sessionArtifactTransferWorkerProvider);
        final second = app.container
            .read(sessionArtifactTransferWorkerProvider)
            .saveCachedTransfer(id);
        await app.settle();
        expect(save.requests, hasLength(1));
        save.pending!.complete();
        save.pending = null;
        await _nativeUntil(app, () => save.requests.length == 2);
        await second;
        expect(_row(app, id)!.status, SessionArtifactTransferStatus.completed);
        for (final code in ['busy', 'no_activity', 'write_failed']) {
          save.error = PlatformException(code: code, message: 'Provider $code');
          await app.tapKey('transfer-manager-save-$id');
          expect(
            _row(app, id)!.status,
            SessionArtifactTransferStatus.completed,
          );
          expect(_row(app, id)!.exportedPath, isNotNull);
          // Opening the disclosure dismisses its snackbar too, so it cannot
          // cover the next Save tap on the phone-sized viewport.
          await app.tap(
            find.widgetWithText(SnackBarAction, 'Technical details'),
          );
          expect(find.textContaining('Provider $code'), findsOneWidget);
          await app.tapKey('contextual-details-close');
        }
        save
          ..error = null
          ..response = null;
        await app.tapKey('transfer-manager-save-$id');
        expect(_row(app, id)!.status, SessionArtifactTransferStatus.completed);
      }
      if (scenario == 'write failure') {
        expect(
          app.visibleText,
          isNot(contains('Document provider refused the write')),
        );
        final diagnosticRow = find
            .ancestor(
              of: find.text('Download: 审阅意见.md'),
              matching: find.byType(ContextualDetails),
            )
            .first;
        await app.tester.longPressAt(
          app.tester.getTopLeft(diagnosticRow) + const Offset(4, 4),
        );
        await app.settle();
        expect(
          find.textContaining('Document provider refused the write'),
          findsOneWidget,
        );
        await app.tapKey('contextual-details-close');
        save.error = null;
        await app.tapKey('transfer-manager-retry-$id');
        await app.pumpUntil(
          () => _row(app, id)?.status == SessionArtifactTransferStatus.running,
          reason: 'retry starts a fresh native download',
        );
        expect(find.byKey(Key('transfer-manager-save-$id')), findsNothing);
        expect(find.byKey(Key('transfer-manager-share-$id')), findsNothing);
        engine.emit(
          BackgroundDownloadRecord(
            taskId: id,
            status: BackgroundDownloadTaskStatus.failed,
            errorMessage: 'Second native failure',
          ),
        );
        await _nativeUntil(
          app,
          () => _row(app, id)?.status == SessionArtifactTransferStatus.failed,
        );
        final nextDiagnosticRow = find
            .ancestor(
              of: find.text('Download: 审阅意见.md'),
              matching: find.byType(ContextualDetails),
            )
            .first;
        await app.tester.longPressAt(
          app.tester.getTopLeft(nextDiagnosticRow) + const Offset(4, 4),
        );
        await app.settle();
        expect(find.textContaining('Second native failure'), findsOneWidget);
        expect(
          find.textContaining('Document provider refused the write'),
          findsNothing,
        );
      }
      if (scenario == 'server switch') {
        expect(_row(app, id)!.exportedPath, startsWith('content:'));
        expect(_row(app, id)!.localFilePath, cached);
        expect(app.visibleText, isNot(contains('content://')));
      }
      expect(app.tester.takeException(), isNull);
    }, platform: TargetPlatform.android);
  }

  featureTest(
    'Android agent artifact uses the system Save as channel',
    (f) async {
      final directory = Directory.systemTemp.createTempSync(
        'artifact-download-feature-',
      );
      final previousPaths = PathProviderPlatform.instance;
      PathProviderPlatform.instance = DownloadTemporaryPaths(directory.path);
      addTearDown(() {
        PathProviderPlatform.instance = previousPaths;
        if (directory.existsSync()) directory.deleteSync(recursive: true);
      });
      final save = FakeAndroidSaveAs()
        ..response = {
          'uri': 'content://documents/review.md',
          'displayName': 'review-saved.md',
        }
        ..install();
      final broker = f.network.add('http://studio.test:7734')
        ..addSession('s1', 'Agent artifact');
      // FakeBroker's existing GET-file route serves real artifact bytes through
      // the production broker client and cache service; no new route is needed.
      broker.files['/api/sessions/codex/s1/artifact/review'] =
          const FakeBrokerResponse.text(200, 'Review fixture', {
            'content-type': 'text/markdown',
            'content-length': '14',
            'x-content-hash': 'version-1',
          });
      broker.transcripts['s1'] = [
        row('file-artifact', {
          'artifactKey': 'review',
          'contentHash': 'version-1',
          'name': 'review.md',
          'mimeType': 'text/markdown',
          'size': 14,
          'fetchUrl':
              '/api/sessions/codex/s1/artifact/review'
              '?expires=4102444800&sig=fixture',
        }),
      ];
      await f.storage.seedServer(broker);
      final app = await f.launch(
        viewport: FeatureViewport.phone,
        overrides: [
          sessionFileBackgroundDownloaderProvider.overrideWithValue(null),
        ],
      );
      await app.tapKey('workspace-open-drawer');
      await app.openFromRoster('s1', cwd: '/work/studio');
      await app.tap(find.text('Download').last);
      await _nativeUntil(app, () => save.requests.isNotEmpty);
      final controller = app.container.read(
        sessionArtifactTransferControllerProvider.notifier,
      );
      await _nativeUntil(
        app,
        () => app.container
            .read(sessionArtifactTransferControllerProvider)
            .any(
              (row) => row.status == SessionArtifactTransferStatus.completed,
            ),
      );
      expect(save.requests.single['suggestedName'], 'review.md');
      final rows = app.container.read(
        sessionArtifactTransferControllerProvider,
      );
      expect(
        controller.transferById(rows.single.id)!.exportedPath,
        startsWith('content:'),
      );
      expect(rows.single.fileName, 'review.md');
      expect(rows.single.savedFileName, 'review-saved.md');
      expect(rows.single.message, 'Saved review-saved.md');
      await app.go(transfersRoute);
      expect(find.text('Saved to device: review-saved.md'), findsWidgets);
      expect(find.textContaining('Saved'), findsWidgets);
      expect(app.tester.takeException(), isNull);
    },
    platform: TargetPlatform.android,
  );
}

SessionArtifactTransfer? _row(AppDriver app, String id) => app.container
    .read(sessionArtifactTransferControllerProvider.notifier)
    .transferById(id);

// Filesystem event barriers, bounded without sleeps, as in file_previews_test.
Future<void> _nativeUntil(AppDriver app, bool Function() condition) async {
  for (var turn = 0; turn < 100 && !condition(); turn++) {
    // An async filesystem probe yields to native I/O callbacks.
    // ignore: avoid_slow_async_io
    await app.tester.runAsync(() => Directory.systemTemp.exists());
    await app.tester.pump(AppDriver.step);
  }
  final messages = app.container
      .read(sessionArtifactTransferControllerProvider)
      .map((row) => row.message)
      .join(' | ');
  expect(
    condition(),
    isTrue,
    reason:
        'native download/cache/export reached its expected state. '
        '\n${app.visibleText}\n'
        '$messages',
  );
  await app.settle();
}

class _DownloadWorkspace implements SessionFileBrowserRepository {
  @override
  Future<FsDirectoryResult> listPath(
    SessionDetailKey key, {
    String path = '',
  }) async => FsDirectoryResult(
    path: path,
    stat: const FsNodeInfo(
      path: '',
      type: 'directory',
      size: 0,
      mtimeMs: 0,
      isDirectory: true,
      isRegularFile: false,
      isSymbolicLink: false,
    ),
    entries: const [
      FsDirEntry(
        name: '审阅意见.md',
        path: '审阅意见.md',
        type: 'file',
        size: 16,
        mtimeMs: 0,
      ),
    ],
  );
  @override
  Future<FsReadResult> readFile(
    SessionDetailKey key, {
    required String path,
    int maxBytes = sessionFilePreviewDefaultMaxBytes,
  }) async => throw UnimplementedError();
}
