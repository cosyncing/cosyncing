import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_media_source.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_file_service.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_file_browser.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:cosyncing_client/src/features/transfers/data/local_transfer_file_opener.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';
import 'package:video_player_platform_interface/video_player_platform_interface.dart'
    as video;

import '../support/feature/composer_driver.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_os_notifications.dart';
import '../support/feature/roster_driver.dart';
import '../support/notification_test_support.dart';
import '../support/session_detail_page_test_harness.dart'
    show
        FakeSessionArtifactFileService,
        RecordingSessionDetailTransferFileOpener;

void main() {
  featureTest(
    'phone retains pinned documents and reader choice across chat and restart',
    (f) async {
      final broker = f.network.add('http://studio.test:7734')
        ..addSession('s1', 'File review');
      await f.storage.seedServer(broker);
      var app = await f.launch(
        viewport: FeatureViewport.phone,
        overrides: [
          sessionFileBrowserRepositoryProvider.overrideWith(
            (ref) async => _TextWorkspace(),
          ),
        ],
      );
      await app.tapKey('workspace-open-drawer');
      await app.openFromRoster('s1', cwd: '/work/studio');
      expect(find.byKey(const Key('compact-manage-files')), findsOneWidget);
      await app.enterText(
        find.byKey(const Key('session-detail-prompt-input')),
        'Keep my draft',
      );
      await app.tapKey('session-detail-view-menu');
      await app.tapKey('session-detail-view-item-files');
      await app.tapKey('session-detail-files-preview-plan.md');
      await app.pumpUntil(
        () => find.text('Rendered').evaluate().isNotEmpty,
        reason: 'shared Markdown reader opens',
      );
      expect(find.byKey(const Key('compact-manage-files')), findsOneWidget);
      expect(find.byKey(const Key('session-file-page')), findsNothing);
      final rendered = find.byKey(const Key('file-viewer-rendered'));
      await app.tester.drag(rendered, const Offset(0, -260));
      await app.settle();
      final renderedOffset = app.tester
          .widget<ListView>(rendered)
          .controller!
          .offset;
      expect(renderedOffset, greaterThan(0));
      await app.tapKey('file-viewer-mode-source');
      final source = find.byKey(const Key('file-viewer-lines'));
      await app.tester.drag(source, const Offset(0, -180));
      await app.settle();
      final sourceOffset = app.tester
          .widget<ListView>(source)
          .controller!
          .offset;
      await app.tapKey('file-viewer-mode-rendered');
      expect(
        app.tester.widget<ListView>(rendered).controller!.offset,
        closeTo(renderedOffset, 2),
      );
      await app.tapKey('file-viewer-mode-source');
      expect(
        app.tester.widget<ListView>(source).controller!.offset,
        closeTo(sourceOffset, 2),
      );
      await app.tapKey('compact-manage-files');
      await app.tap(find.byTooltip('Pin file'));
      await app.tapKey('compact-files-close');
      await app.tap(find.text('Chat').first);
      expect(find.text('Keep my draft'), findsOneWidget);
      await app.tap(find.text('plan.md').first);
      expect(
        app.tester.widget<ListView>(source).controller!.offset,
        closeTo(sourceOffset, 2),
      );
      app.tester.view.physicalSize = const Size(1440, 900);
      await app.settle();
      expect(find.byKey(const Key('file-tabs-strip')), findsOneWidget);
      expect(
        app.tester.widget<ListView>(source).controller!.offset,
        closeTo(sourceOffset, 2),
      );
      app.tester.view.physicalSize = FeatureViewport.phone.size;
      await app.settle();
      expect(
        app.tester.widget<ListView>(source).controller!.offset,
        closeTo(sourceOffset, 2),
      );
      await app.tapKey('compact-manage-files');
      await app.tap(find.text('Files').last);
      await app.tapKey('session-detail-files-preview-notes.md');
      await app.tapKey('compact-manage-files');
      await app.tap(find.byTooltip('Pin file'));
      await app.tapKey('compact-files-close');
      await app.tap(find.text('plan.md').first);
      await app.tapKey('file-viewer-close');
      await app.tap(find.text('Undo'));
      final panes = app.container
          .read(filePanesControllerProvider)
          .requireValue;
      expect(panes.pinned, hasLength(2));
      expect(panes.modes.values, contains('source'));
      app.tester.view.physicalSize = const Size(1440, 900);
      await app.settle();
      final tabs = find.byKey(const Key('file-tabs-strip'));
      Finder fileTab(String name) =>
          find.descendant(of: tabs, matching: find.text(name));
      await app.tap(fileTab('plan.md'));
      await app.tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await app.tap(fileTab('notes.md'));
      await app.tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      expect(find.byKey(const Key('file-close-selected-tabs')), findsOneWidget);
      await app.chord(
        LogicalKeyboardKey.keyW,
        modifiers: [LogicalKeyboardKey.controlLeft],
      );
      expect(
        app.container
            .read(filePanesControllerProvider)
            .requireValue
            .panes
            .map((pane) => pane.key),
        [
          const SessionPanelKey(
            session: SessionDetailKey(tool: 'codex', sessionId: 's1'),
            kind: SessionPanelKind.files,
          ).key,
        ],
      );
      expect(app.openTabKeys, ['codex/s1']);
      await app.tap(find.text('Undo'));
      final restored = app.container
          .read(filePanesControllerProvider)
          .requireValue;
      expect(
        restored.panes.whereType<FilePaneKey>().map((pane) => pane.key),
        panes.panes.map((pane) => pane.key),
      );
      expect(restored.pinned, panes.pinned);
      expect(restored.modes, panes.modes);
      app.tester.view.physicalSize = FeatureViewport.phone.size;
      await app.settle();
      app = await f.restart();
      await app.tapKey('workspace-open-drawer');
      await app.openFromRoster('s1', cwd: '/work/studio');
      await app.tap(find.text('plan.md').first);
      expect(
        app.container.read(filePanesControllerProvider).requireValue.pinned,
        hasLength(2),
      );
      await app.tapKey('compact-manage-files');
      final notes = find.ancestor(
        of: find.text('notes.md').last,
        matching: find.byType(ListTile),
      );
      await app.tap(
        find.descendant(of: notes, matching: find.byTooltip('Unpin file')),
      );
      await app.tapKey('compact-file-actions');
      await app.tap(find.text('Close all unpinned files'));
      expect(
        app.container
            .read(filePanesControllerProvider)
            .requireValue
            .panes
            .whereType<FilePaneKey>(),
        hasLength(1),
      );
      expect(
        app.container.read(filePanesControllerProvider).requireValue.pinned,
        hasLength(1),
      );
      await app.tap(find.text('Undo'));
      expect(
        app.container
            .read(filePanesControllerProvider)
            .requireValue
            .panes
            .whereType<FilePaneKey>(),
        hasLength(2),
      );
      // System Back returns to the retained view before leaving the session.
      await app.tap(find.text('plan.md').first);
      await app.tapKey('workspace-open-drawer');
      await app.tester.binding.handlePopRoute();
      await app.settle();
      expect(find.byKey(const Key('file-viewer-pane')), findsOneWidget);
      await app.tester.binding.handlePopRoute();
      await app.settle();
      expect(find.byKey(const Key('file-viewer-pane')), findsNothing);
      expect(find.byKey(const Key('compact-manage-files')), findsOneWidget);

      // Moving one step stays within its pin group, even when the stored
      // desktop order interleaves pinned and unpinned documents.
      for (final path in ['log.md', 'todo.md']) {
        await app.tapKey('compact-manage-files');
        await app.tap(find.text('Files').last);
        await app.tapKey('session-detail-files-preview-$path');
      }
      await app.tapKey('compact-manage-files');
      Finder fileRow(String path) => find.ancestor(
        of: find.text(path).last,
        matching: find.byType(ListTile),
      );
      List<String> visibleOrder() => app.tester
          .widgetList<ListTile>(find.byType(ListTile))
          .map((tile) => tile.title)
          .whereType<Text>()
          .map((text) => text.data ?? '')
          .where((text) => text.endsWith('.md'))
          .toList();
      Future<void> moveFile(String path, String action) async {
        await app.tap(
          find.descendant(
            of: fileRow(path),
            matching: find.byTooltip('Manage files'),
          ),
        );
        await app.tap(find.text(action));
      }

      expect(visibleOrder(), ['plan.md', 'notes.md', 'log.md', 'todo.md']);
      await moveFile('notes.md', 'Move later');
      expect(visibleOrder(), ['plan.md', 'log.md', 'notes.md', 'todo.md']);
      await moveFile('notes.md', 'Move earlier');
      expect(visibleOrder(), ['plan.md', 'notes.md', 'log.md', 'todo.md']);
      await app.tap(
        find.descendant(
          of: fileRow('log.md'),
          matching: find.byTooltip('Pin file'),
        ),
      );
      await moveFile('plan.md', 'Move later');
      expect(visibleOrder(), ['log.md', 'plan.md', 'notes.md', 'todo.md']);
      await app.tapKey('compact-files-close');
      app = await f.restart();
      await app.tapKey('workspace-open-drawer');
      await app.openFromRoster('s1', cwd: '/work/studio');
      await app.tapKey('compact-manage-files');
      expect(visibleOrder(), ['log.md', 'plan.md', 'notes.md', 'todo.md']);
      expect(app.tester.takeException(), isNull);
    },
  );

  for (final (theme, outcome) in [
    ('light', 'playback'),
    ('dark', 'background'),
    ('light', 'creation failure'),
    ('light', 'close during creation'),
  ]) {
    final failsCreation = outcome.contains('creation');
    final closeDuringCreation = outcome == 'close during creation';
    featureTest(
      'phone plays inline video with onboarding visible and releases '
      'its temporary file after the decoder closes ($theme, $outcome)',
      (f) async {
        final directory = Directory.systemTemp.createTempSync('media-feature-');
        final previousPaths = PathProviderPlatform.instance;
        final previousPlayer = video.VideoPlayerPlatform.instance;
        final player = _NativeVideoPlayer(failsCreation: failsCreation);
        if (!closeDuringCreation) player.allowCreation.complete();
        final lifecycle = ControllableLifecycleMonitor();
        PathProviderPlatform.instance = _TemporaryPaths(directory.path);
        video.VideoPlayerPlatform.instance = player;
        addTearDown(() async {
          if (!player.allowCreation.isCompleted) {
            player.allowCreation.complete();
          }
          if (!player.allowDispose.isCompleted) player.allowDispose.complete();
          PathProviderPlatform.instance = previousPaths;
          video.VideoPlayerPlatform.instance = previousPlayer;
          lifecycle.dispose();
          if (directory.existsSync()) directory.deleteSync(recursive: true);
        });
        final broker = f.network.add('http://studio.test:7734')
          ..addSession('s1', 'Legacy video');
        final bytes = Uint8List.fromList(utf8.encode('native decoder fixture'));
        final files = _MediaWorkspace(inlineVideo: bytes);
        await f.storage.seedServer(broker);
        await f.storage.preferences.setThemeMode(theme);
        final app = await f.launch(
          viewport: FeatureViewport.phone,
          overrides: [
            ...FakeOsNotifications().overrides(lifecycle),
            sessionFileBrowserRepositoryProvider.overrideWith(
              (ref) async => files,
            ),
          ],
        );
        await app.tapKey('workspace-open-drawer');
        await app.openFromRoster('s1', cwd: '/work/studio');
        expect(player.sources, isEmpty);
        await app.tapKey('session-detail-view-menu');
        await app.tapKey('session-detail-view-item-files');
        await app.tapKey('session-detail-files-preview-legacy.mp4');
        await _pumpNativeIoUntil(app.tester, () => player.sources.isNotEmpty);
        if (closeDuringCreation) {
          await app.pumpUntil(
            () => player.sources.isNotEmpty,
            reason: 'native player creation begins',
          );
          final file = File.fromUri(Uri.parse(player.sources.single.uri!));
          await app.tapKey('file-viewer-close');
          expect(file.existsSync(), isTrue);
          player.allowCreation.complete();
          await _pumpNativeIoUntil(app.tester, () => !file.parent.existsSync());
          return;
        }
        if (failsCreation) {
          await _pumpNativeIoUntil(
            app.tester,
            () => find
                .text(
                  'This file could not be previewed. '
                  'Try opening it in another app.',
                )
                .evaluate()
                .isNotEmpty,
          );
          final file = File.fromUri(Uri.parse(player.sources.single.uri!));
          await _pumpNativeIoUntil(app.tester, () => !file.parent.existsSync());
          await app.tapKey('file-viewer-close');
          expect(app.activeTabKey, 'codex/s1');
          return;
        }
        await app.waitFor(find.byTooltip('Play'));
        expect(player.sources.single.sourceType, video.DataSourceType.file);
        final file = File.fromUri(Uri.parse(player.sources.single.uri!));
        expect(file.readAsBytesSync(), bytes);
        expect(player.plays, 0, reason: 'opening a video never auto-plays');
        final banner = find.byKey(const Key('notification-onboarding-banner'));
        expect(banner, findsOneWidget);
        expect(
          app.tester.getBottomRight(find.byTooltip('Mute')).dy,
          lessThan(app.tester.getTopLeft(banner).dy),
          reason: 'onboarding reserves space instead of covering controls',
        );
        await app.tap(find.byTooltip('Play'));
        expect(player.plays, 1);
        await app.tap(find.byTooltip('Pause'));
        await app.tap(find.byTooltip('Mute'));
        expect(player.volumes.last, 0);
        await app.tapKey('notification-onboarding-dismiss');
        expect(banner, findsNothing);
        if (outcome == 'background') {
          await app.tap(find.byTooltip('Play'));
          final pauses = player.pauses;
          for (final state in [
            AppLifecycleState.inactive,
            AppLifecycleState.hidden,
            AppLifecycleState.paused,
          ]) {
            app.tester.binding.handleAppLifecycleStateChanged(state);
          }
          expect(
            player.pauses,
            greaterThan(pauses),
            reason: 'background playback stops before another UI frame',
          );
          for (final state in [
            AppLifecycleState.hidden,
            AppLifecycleState.inactive,
            AppLifecycleState.resumed,
          ]) {
            app.tester.binding.handleAppLifecycleStateChanged(state);
          }
          await app.flushRealAsync();
          await app.tester.idle();
          await _pumpNativeIoUntil(
            app.tester,
            () => player.sources.length == 2,
          );
          await app.waitFor(find.byTooltip('Play'));
          expect(player.plays, 2, reason: 'resuming does not auto-play');
        }
        await app.tapKey('file-viewer-close');
        app.tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        expect(find.byKey(const Key('file-viewer-pane')), findsNothing);
        await _pumpNativeIoUntil(app.tester, () => player.disposeStarted);
        expect(player.disposeStarted, isTrue);
        expect(
          file.existsSync(),
          isTrue,
          reason: 'the decoder still owns the file handle',
        );
        player.allowDispose.complete();
        await _pumpNativeIoUntil(
          app.tester,
          () => directory.listSync().isEmpty,
        );
      },
      platform: TargetPlatform.android,
    );
  }

  for (final viewport in [FeatureViewport.desktop, FeatureViewport.phone]) {
    featureTest(
      'media is lazy and closes without delaying navigation '
      'at ${viewport.name}',
      (f) async {
        final broker = f.network.add('http://studio.test:7734')
          ..addSession('s1', 'Images')
          ..addSession('s2', 'Other work');
        final files = _MediaWorkspace();
        await f.storage.seedServer(broker);
        final app = await f.launch(
          viewport: viewport,
          overrides: [
            sessionFileBrowserRepositoryProvider.overrideWith(
              (ref) async => files,
            ),
          ],
        );
        if (viewport == FeatureViewport.phone) {
          await app.tapKey('workspace-open-drawer');
        }
        await app.openFromRoster('s1', cwd: '/work/studio');
        expect(
          files.loads,
          0,
          reason: 'opening a session does not load any media',
        );
        await app.tapKey('session-detail-view-menu');
        await app.tapKey('session-detail-view-item-files');
        expect(files.loads, 0, reason: 'listing files does not decode images');
        await app.tapKey('session-detail-files-preview-picture.png');
        await app.pumpUntil(
          () => files.loads == 1,
          reason: 'only the selected image loads',
        );
        expect(find.byKey(const Key('file-viewer-copy')), findsNothing);
        expect(find.byKey(const Key('file-viewer-wrap')), findsNothing);
        await app.tapKey('file-viewer-close');
        expect(
          files.releases,
          1,
          reason: 'closing the preview releases its media capability',
        );
        expect(
          broker.requests.where(
            (r) => r.method == 'DELETE' && r.path.contains('/sessions/'),
          ),
          isEmpty,
        );
        if (viewport == FeatureViewport.phone) {
          await app.tapKey('workspace-open-drawer');
        }
        await app.openFromRoster('s2');
        expect(app.activeTabKey, 'codex/s2');
        expect(
          files.loads,
          1,
          reason:
              'switching/opening another session does not fetch the closed image',
        );
      },
    );
  }

  featureTest(
    'hiding a session releases its image and reactivating loads once',
    (f) async {
      final broker = f.network.add('http://studio.test:7734')
        ..addSession('s1', 'Images')
        ..addSession('s2', 'Other work');
      final files = _MediaWorkspace();
      await f.storage.seedServer(broker);
      final app = await f.launch(
        overrides: [
          sessionFileBrowserRepositoryProvider.overrideWith(
            (ref) async => files,
          ),
        ],
      );
      await app.openFromRoster('s1', cwd: '/work/studio');
      await app.tapKey('session-detail-view-menu');
      await app.tapKey('session-detail-view-item-files');
      await app.tapKey('session-detail-files-preview-picture.png');
      await app.pumpUntil(
        () => files.loads == 1,
        reason: 'selected image loads',
      );
      await app.openFromRoster('s2');
      expect(files.releases, 1);
      await app.tester.tap(app.tab('s1'));
      await app.settle();
      await app.pumpUntil(
        () => files.loads == 2,
        reason: 'returning to the preview reacquires its resource',
      );
      await app.tapKey('open-session-tab-close-codex/s1');
      expect(files.releases, 2);
      expect(app.activeTabKey, 'codex/s2');
    },
  );

  featureTest(
    'phone opens Word and PowerPoint files through the native handler',
    (f) async {
      final broker = f.network.add('http://studio.test:7734')
        ..addSession('s1', 'Documents');
      final files = _MediaWorkspace();
      final opener = RecordingSessionDetailTransferFileOpener();
      await f.storage.seedServer(broker);
      final app = await f.launch(
        viewport: FeatureViewport.phone,
        overrides: [
          sessionFileBrowserRepositoryProvider.overrideWith(
            (ref) async => files,
          ),
          sessionArtifactFileServiceProvider.overrideWithValue(
            FakeSessionArtifactFileService(),
          ),
          localTransferFileOpenerProvider.overrideWithValue(opener),
        ],
      );
      await app.tapKey('workspace-open-drawer');
      await app.openFromRoster('s1', cwd: '/work/studio');
      await app.tapKey('session-detail-view-menu');
      await app.tapKey('session-detail-view-item-files');
      for (final name in ['slides.pptx', 'document.docx']) {
        await app.tapKey('session-detail-files-open-with-$name');
        await app.pumpUntil(
          () => opener.openedPaths.contains(name),
          reason: 'OS receives the original document filename',
        );
      }
      expect(opener.openedPaths, ['slides.pptx', 'document.docx']);
      expect(
        files.loads,
        0,
        reason: 'external documents do not start a media decoder',
      );
    },
  );

  featureTest(
    'a slow preview finishing after close releases its source '
    'and never reopens',
    (f) async {
      final broker = f.network.add('http://studio.test:7734')
        ..addSession('s1', 'Images');
      final pending = Completer<FileMediaSource>();
      final files = _MediaWorkspace()..pending = pending;
      await f.storage.seedServer(broker);
      final app = await f.launch(
        overrides: [
          sessionFileBrowserRepositoryProvider.overrideWith(
            (ref) async => files,
          ),
        ],
      );
      await app.openFromRoster('s1', cwd: '/work/studio');
      await app.tapKey('session-detail-view-menu');
      await app.tapKey('session-detail-view-item-files');
      await app.tapKey('session-detail-files-preview-picture.png');
      await app.pumpUntil(() => files.loads == 1, reason: 'request is held');
      await app.tapKey('file-viewer-close');
      pending.complete(
        FileMediaSource(bytes: _png, release: () => files.releases++),
      );
      await app.pumpUntil(
        () => files.releases == 1,
        reason: 'late source is revoked',
      );
      expect(find.byKey(const Key('file-viewer-pane')), findsNothing);
      expect(app.activeTabKey, 'codex/s1');
    },
  );
}

// Native file operations need actual I/O event turns, not only fake-clock
// frames. An awaited filesystem probe is an event barrier, with no sleep or
// product timeout expansion. The normal app driver still owns UI assertions.
Future<void> _pumpNativeIoUntil(
  WidgetTester tester,
  bool Function() condition,
) async {
  for (var turn = 0; turn < 100 && !condition(); turn++) {
    // Intentional async I/O: a synchronous probe cannot yield to file callbacks.
    // ignore: avoid_slow_async_io
    await tester.runAsync(() => Directory.systemTemp.exists());
    await tester.pump();
  }
  expect(condition(), isTrue, reason: 'native media I/O completed');
}

class _TemporaryPaths extends PathProviderPlatform {
  _TemporaryPaths(this.path);
  final String path;
  @override
  Future<String> getTemporaryPath() async => path;
}

/// Native decoder boundary: real app file preparation and controls, fake codec.
class _NativeVideoPlayer extends video.VideoPlayerPlatform {
  _NativeVideoPlayer({required this.failsCreation});
  final bool failsCreation;
  final sources = <video.DataSource>[];
  final volumes = <double>[];
  final allowCreation = Completer<void>();
  final allowDispose = Completer<void>();
  int plays = 0;
  int pauses = 0;
  bool disposeStarted = false;
  @override
  Future<void> init() async {}
  @override
  Future<void> setMixWithOthers(bool mixWithOthers) async {}
  @override
  Future<int> createWithOptions(video.VideoCreationOptions options) async {
    sources.add(options.dataSource);
    await allowCreation.future;
    if (failsCreation) throw StateError('Native decoder creation failed');
    return sources.length;
  }

  @override
  Stream<video.VideoEvent> videoEventsFor(int playerId) => Stream.value(
    video.VideoEvent(
      eventType: video.VideoEventType.initialized,
      duration: const Duration(minutes: 1),
      size: const Size(320, 180),
    ),
  );
  @override
  Widget buildViewWithOptions(video.VideoViewOptions options) =>
      const SizedBox.expand();
  @override
  Future<void> setLooping(int playerId, bool looping) async {}
  @override
  Future<void> play(int playerId) async {
    plays++;
  }

  @override
  Future<void> pause(int playerId) async {
    pauses++;
  }

  @override
  Future<void> setVolume(int playerId, double volume) async =>
      volumes.add(volume);
  @override
  Future<void> seekTo(int playerId, Duration position) async {}
  @override
  Future<Duration> getPosition(int playerId) async => Duration.zero;
  @override
  Future<void> setPlaybackSpeed(int playerId, double speed) async {}
  @override
  Future<void> setPreventsDisplaySleepDuringVideoPlayback(
    int playerId,
    bool preventsDisplaySleepDuringVideoPlayback,
  ) async {}
  @override
  Future<void> dispose(int playerId) async {
    disposeStarted = true;
    await allowDispose.future;
  }
}

final Uint8List _png = base64Decode(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8'
  'BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
);

/// Host boundary: real app navigation/view lifecycle, controlled media arrival.
class _MediaWorkspace
    implements SessionFileBrowserRepository, SessionMediaPreviewRepository {
  _MediaWorkspace({this.inlineVideo});
  final Uint8List? inlineVideo;
  int loads = 0;
  int releases = 0;
  Completer<FileMediaSource>? pending;
  @override
  FileMediaPreview mediaPreview(
    SessionDetailKey session,
    String path,
    FileMediaKind kind,
  ) => FileMediaPreview(
    kind: kind,
    load: () async {
      loads++;
      if (pending != null) return pending!.future;
      return FileMediaSource(
        bytes: path == 'legacy.mp4' ? inlineVideo : _png,
        release: () => releases++,
      );
    },
  );
  @override
  Future<FsDirectoryResult> listPath(
    SessionDetailKey sessionKey, {
    String path = '',
  }) async => const FsDirectoryResult(
    path: '',
    stat: FsNodeInfo(
      path: '',
      type: 'directory',
      size: 0,
      mtimeMs: 0,
      isDirectory: true,
      isRegularFile: false,
      isSymbolicLink: false,
    ),
    entries: [
      FsDirEntry(
        name: 'legacy.mp4',
        path: 'legacy.mp4',
        type: 'file',
        size: 22,
        mtimeMs: 0,
      ),
      FsDirEntry(
        name: 'document.docx',
        path: 'document.docx',
        type: 'file',
        size: 30,
        mtimeMs: 0,
      ),
      FsDirEntry(
        name: 'slides.pptx',
        path: 'slides.pptx',
        type: 'file',
        size: 30,
        mtimeMs: 0,
      ),
      FsDirEntry(
        name: 'picture.png',
        path: 'picture.png',
        type: 'file',
        size: 3 * 1024 * 1024,
        mtimeMs: 0,
      ),
    ],
  );
  @override
  Future<FsReadResult> readFile(
    SessionDetailKey sessionKey, {
    required String path,
    int maxBytes = sessionFilePreviewDefaultMaxBytes,
  }) => throw StateError(
    'A media preview must not go through the truncated text read',
  );
}

class _TextWorkspace extends _MediaWorkspace {
  @override
  Future<FsDirectoryResult> listPath(
    SessionDetailKey sessionKey, {
    String path = '',
  }) async {
    final base = await super.listPath(sessionKey, path: path);
    return FsDirectoryResult(
      path: base.path,
      stat: base.stat,
      entries: const [
        FsDirEntry(
          name: 'log.md',
          path: 'log.md',
          type: 'file',
          size: 40,
          mtimeMs: 0,
        ),
        FsDirEntry(
          name: 'todo.md',
          path: 'todo.md',
          type: 'file',
          size: 40,
          mtimeMs: 0,
        ),
        FsDirEntry(
          name: 'notes.md',
          path: 'notes.md',
          type: 'file',
          size: 40,
          mtimeMs: 0,
        ),
        FsDirEntry(
          name: 'plan.md',
          path: 'plan.md',
          type: 'file',
          size: 40,
          mtimeMs: 0,
        ),
      ],
    );
  }

  @override
  Future<FsReadResult> readFile(
    SessionDetailKey sessionKey, {
    required String path,
    int maxBytes = sessionFilePreviewDefaultMaxBytes,
  }) async => FsReadResult(
    path: path,
    size: 40,
    limit: maxBytes,
    truncated: false,
    encoding: 'utf8',
    data: [
      '# Review plan',
      for (var i = 0; i < 100; i++)
        'Review section $i. Keep this file reachable.',
    ].join('\n\n'),
    mimeType: 'text/markdown',
  );
}
