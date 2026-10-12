import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/artifact_pane.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_viewer_pane.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_bootstrap_state.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_connection.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_pane_surface.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/side_pane_scope.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

const _session = SessionDetailKey(tool: 'claude', sessionId: 'session-1');
const _captureKey = Key('session-panel-capture');

Widget _subject({
  required bool wide,
  List<WireEvent> events = const [],
  FakeBrokerClient? client,
  SeededSessionDetailController? controller,
  double rightWidth = 520,
  Brightness brightness = Brightness.light,
}) {
  final spec = themeSpecById(kDefaultThemeId);
  return buildSessionDetailTestPage(
    events: events,
    brokerClient: client,
    seededController: controller,
    embedded: true,
    theme: buildAppTheme(
      brightness == Brightness.light ? spec.light : spec.dark,
      brightness,
    ),
    homeBuilder: (page) => RepaintBoundary(
      key: _captureKey,
      child: Scaffold(
        body: SidePaneScope(
          available: wide,
          expand: () {},
          child: Row(
            children: [
              Expanded(child: page),
              if (wide)
                SizedBox(
                  width: rightWidth,
                  child: const FilePaneSurface(session: _session),
                ),
            ],
          ),
        ),
      ),
    ),
  );
}

MessageWireEvent _artifact(
  String name,
  String text, {
  bool proactive = false,
}) => MessageWireEvent(
  seq: 1,
  message: AgentMessage.fromJson({
    'type': 'file-artifact',
    'artifactKey': 'sent-file',
    'name': name,
    'mimeType': 'text/plain',
    'size': utf8.encode(text).length,
    'proactive': proactive,
    'url': Uri.dataFromString(
      text,
      mimeType: 'text/plain',
      encoding: utf8,
    ).toString(),
  }),
);

ProviderContainer _container(WidgetTester tester) => ProviderScope.containerOf(
  tester.element(find.byType(FilePaneSurface)),
  listen: false,
);

Future<void> _wide(WidgetTester tester) async {
  await tester.binding.setSurfaceSize(const Size(1440, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
}

Future<void> _capture(WidgetTester tester, String name) async {
  if (Platform.environment['COSYNCING_UI_SCREENSHOTS'] != '1') return;
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byKey(_captureKey),
  );
  await tester.runAsync(() async {
    final image = await boundary.toImage();
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    final file = File('../../output/session-file-panel/$name.png');
    await file.parent.create(recursive: true);
    await file.writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    final font = FontLoader('Lato')
      ..addFont(rootBundle.load('assets/fonts/Lato-Regular.ttf'))
      ..addFont(rootBundle.load('assets/fonts/Lato-Semibold.ttf'))
      ..addFont(rootBundle.load('assets/fonts/Lato-Bold.ttf'));
    await font.load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });
  for (final brightness in Brightness.values) {
    testWidgets(
      'wide Files opens previews beside the explorer: ${brightness.name}',
      (tester) async {
        await _wide(tester);
        final client = FakeBrokerClient()
          ..fsListingsByPath[''] = const FsDirectoryResult(
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
                name: 'notes.md',
                path: 'notes.md',
                type: 'file',
                size: 20,
                mtimeMs: 0,
              ),
            ],
          )
          ..fsReadResult = const FsReadResult(
            path: 'notes.md',
            size: 20,
            limit: 1048576,
            truncated: false,
            encoding: 'utf8',
            data: '# Project notes\n\nA readable preview.',
            mimeType: 'text/markdown',
          );
        await tester.pumpWidget(
          _subject(wide: true, client: client, brightness: brightness),
        );
        await tester.pumpAndSettle();
        await openSessionDetailTestTab(tester, 'session-detail-tab-files');
        final container = _container(tester);
        expect(
          container
              .read(filePanesControllerProvider)
              .requireValue
              .activeFor(_session),
          const SessionPanelKey(
            session: _session,
            kind: SessionPanelKind.files,
          ),
        );
        expect(
          find.byKey(const Key('session-detail-tab-panel-chat')),
          findsOneWidget,
        );
        await tester.tap(
          find.byKey(const Key('session-detail-files-name-notes.md')),
        );
        await tester.pumpAndSettle();
        final tabs = container
            .read(filePanesControllerProvider)
            .requireValue
            .forSession(_session);
        expect(tabs, [
          const SessionPanelKey(
            session: _session,
            kind: SessionPanelKind.files,
          ),
          const FilePaneKey(session: _session, path: 'notes.md'),
        ]);
        expect(find.byType(FileViewerPane), findsOneWidget);
        await _capture(tester, 'preview-${brightness.name}');
        await tester.tap(
          find.descendant(
            of: find.byKey(const Key('file-tabs-strip')),
            matching: find.text('Files'),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(const Key('session-detail-files-name-notes.md')),
          findsOneWidget,
        );
        await _capture(tester, 'files-${brightness.name}');
        expect(tester.takeException(), isNull);
      },
    );
  }

  for (final name in ['notes.md', 'index.html', 'main.py']) {
    testWidgets('sent $name stays openable when tool calls are hidden', (
      tester,
    ) async {
      await _wide(tester);
      const text = 'This is the delivered version.';
      await tester.pumpWidget(
        _subject(wide: true, events: [_artifact(name, text)]),
      );
      await tester.pumpAndSettle();
      await toggleSessionDetailViewOption(tester, 'report');
      expect(
        find.byKey(
          const Key('session-detail-chat-artifact-download-sent-file'),
        ),
        findsOneWidget,
      );
      await tester.tap(
        find.byKey(const Key('session-detail-chat-artifact-open-sent-file')),
      );
      await tester.pumpAndSettle();
      expect(
        _container(
          tester,
        ).read(filePanesControllerProvider).requireValue.activeFor(_session),
        ArtifactPaneKey(session: _session, artifactId: 'sent-file', name: name),
      );
      final pane = tester.widget<FileViewerPane>(find.byType(FileViewerPane));
      expect((pane.content as FileViewerSource).preview.text, text);
      expect(
        find.byKey(const Key('session-detail-tab-panel-chat')),
        findsOneWidget,
      );
    });
  }

  testWidgets('an opened file survives leaving the transcript history window', (
    tester,
  ) async {
    await _wide(tester);
    final controller = SeededSessionDetailController(
      SessionDetailState(
        tool: _session.tool,
        sessionId: _session.sessionId,
        source: RosterSource.ofProfile(createTestBrokerProfile()),
        connectionStatus: SessionDetailConnectionStatus.connected,
        bootstrapState: const SessionDetailBootstrapState(
          readiness: SessionDetailBootstrapReadiness.ready,
        ),
        events: [_artifact('notes.md', '# Keep this preview')],
      ),
    );
    await tester.pumpWidget(_subject(wide: true, controller: controller));
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const Key('session-detail-chat-artifact-open-sent-file')),
    );
    await tester.pumpAndSettle();
    controller.emittedState = controller.emittedState.copyWith(
      events: const [],
    );
    expect(controller.emittedState.fileArtifactDescriptors, isEmpty);
    // Force another read, as switching away from a preview and back does.
    _container(tester).invalidate(
      artifactPaneReadProvider(
        const ArtifactPaneKey(
          session: _session,
          artifactId: 'sent-file',
          name: 'notes.md',
        ),
      ),
    );
    await tester.pumpAndSettle();
    final pane = tester.widget<FileViewerPane>(find.byType(FileViewerPane));
    expect(
      (pane.content as FileViewerSource).preview.text,
      '# Keep this preview',
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('the transcript remains usable beside a maximized file pane', (
    tester,
  ) async {
    await _wide(tester);
    await tester.pumpWidget(
      _subject(
        wide: true,
        rightWidth: 1160,
        events: [_artifact('notes.md', '# A wide file')],
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const Key('session-detail-chat-artifact-open-sent-file')),
    );
    await tester.pumpAndSettle();
    expect(find.byType(FileViewerPane), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  for (final width in [280.0, 390.0]) {
    for (final scale in width == 280 ? [1.0] : [1.0, 2.0]) {
      testWidgets('delivered filename remains readable at $width / $scale', (
        tester,
      ) async {
        await tester.binding.setSurfaceSize(Size(width, 900));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        await tester.pumpWidget(
          _subject(
            wide: false,
            events: [_artifact('report.md', '# Report', proactive: true)],
          ),
        );
        await tester.pumpAndSettle();
        final name = tester.renderObject<RenderParagraph>(
          find.descendant(
            of: find.text('report.md'),
            matching: find.byType(RichText),
          ),
        );
        expect(name.size.width, greaterThan(100));
        expect(name.didExceedMaxLines, isFalse);
        expect(find.text('Sent to you'), findsOneWidget);
        expect(
          find.byKey(const Key('session-detail-chat-artifact-open-sent-file')),
          findsOneWidget,
        );
        expect(
          find.byKey(
            const Key('session-detail-chat-artifact-download-sent-file'),
          ),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      });
    }
  }

  for (final view in ['status', 'files']) {
    testWidgets('$view follows the available panel when resizing', (
      tester,
    ) async {
      await _wide(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          embedded: true,
          homeBuilder: (page) => Scaffold(
            body: LayoutBuilder(
              builder: (context, constraints) {
                final wide = constraints.maxWidth >= 1000;
                return SidePaneScope(
                  available: wide,
                  expand: () {},
                  child: Row(
                    children: [
                      Expanded(child: page),
                      if (wide)
                        const SizedBox(
                          width: 520,
                          child: FilePaneSurface(session: _session),
                        ),
                    ],
                  ),
                );
              },
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await openSessionDetailTestTab(tester, 'session-detail-tab-$view');
      final container = _container(tester);
      final expected = SessionPanelKey(
        session: _session,
        kind: view == 'status'
            ? SessionPanelKind.status
            : SessionPanelKind.files,
      );
      expect(
        container
            .read(filePanesControllerProvider)
            .requireValue
            .activeFor(_session),
        expected,
      );
      expect(
        find.byKey(const Key('session-detail-tab-panel-chat')),
        findsOneWidget,
      );
      await tester.binding.setSurfaceSize(const Size(390, 844));
      await tester.pumpAndSettle();
      expect(find.byType(FilePaneSurface), findsNothing);
      expect(find.byKey(Key('session-detail-tab-panel-$view')), findsOneWidget);
      await tester.binding.setSurfaceSize(const Size(1440, 900));
      await tester.pumpAndSettle();
      expect(find.byType(FilePaneSurface), findsOneWidget);
      expect(
        find.byKey(const Key('session-detail-tab-panel-chat')),
        findsOneWidget,
      );
      expect(
        container
            .read(filePanesControllerProvider)
            .requireValue
            .forSession(_session),
        [expected],
      );
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('small screens keep Status and Files in the main view', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(_subject(wide: false));
    await tester.pumpAndSettle();
    await openSessionDetailTestTab(tester, 'session-detail-tab-status');
    expect(
      find.byKey(const Key('session-detail-tab-panel-status')),
      findsOneWidget,
    );
    await openSessionDetailTestTab(tester, 'session-detail-tab-files');
    expect(
      find.byKey(const Key('session-detail-tab-panel-files')),
      findsOneWidget,
    );
    expect(find.byType(FilePaneSurface), findsNothing);
  });

  testWidgets('small screens open sent text without replacing the transcript', (
    tester,
  ) async {
    await tester.pumpWidget(
      _subject(wide: false, events: [_artifact('main.py', 'print(42)')]),
    );
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const Key('session-detail-chat-artifact-open-sent-file')),
    );
    await tester.pumpAndSettle();
    expect(find.byType(ArtifactPaneBody), findsOneWidget);
    expect(
      (tester.widget<FileViewerPane>(find.byType(FileViewerPane)).content
              as FileViewerSource)
          .preview
          .text,
      'print(42)',
    );
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(
      find.byKey(const Key('session-detail-tab-panel-chat')),
      findsOneWidget,
    );
  });
}
