import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_pane_surface.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/side_pane_scope.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

const _captureKey = Key('search-capture');
const _session = SessionDetailKey(tool: 'claude', sessionId: 'session-1');

FsNodeInfo _node(String path, {bool directory = false}) => FsNodeInfo(
  path: path,
  type: directory ? 'directory' : 'file',
  size: 30,
  mtimeMs: 0,
  isDirectory: directory,
  isRegularFile: !directory,
  isSymbolicLink: false,
);

class _SearchClient extends FakeBrokerClient {
  _SearchClient({this.matches = const [], this.partial = false});
  final List<String> matches;
  final bool partial;
  final queries = <String>[];
  final paths = <String, String>{};
  Completer<FsSearchResult>? pending;

  @override
  Future<FsDirectoryResult> listSessionDirectory(
    String tool,
    String id, {
    String? path,
  }) async {
    fsListedPaths.add(path);
    if (path == null || path.isEmpty || path == 'transfer') {
      return FsDirectoryResult(
        path: path ?? '',
        stat: _node(path ?? '', directory: true),
        entries: const [],
      );
    }
    final found = paths[path];
    if (found == null) {
      throw const BrokerException(
        message: 'missing',
        statusCode: 404,
        error: BrokerError(error: 'missing', code: 'NOT_FOUND'),
      );
    }
    return FsDirectoryResult(
      path: found,
      stat: _node(found),
      entries: const [],
    );
  }

  @override
  Future<FsSearchResult> searchSessionFiles(
    String tool,
    String id, {
    required String query,
  }) async {
    queries.add(query);
    return pending?.future ??
        FsSearchResult(
          query: query,
          matches: matches.map(_node).toList(),
          truncated: partial,
        );
  }

  @override
  Future<FsReadResult> readSessionFile(
    String tool,
    String id, {
    String? path,
    int? maxBytes,
  }) async {
    fsReadPaths.add(path);
    return FsReadResult(
      path: path!,
      size: 30,
      limit: 1024,
      truncated: false,
      encoding: 'utf8',
      data: 'first\nsecond\nthird',
      mimeType: 'text/plain',
    );
  }
}

MessageWireEvent _report(String text) => MessageWireEvent(
  seq: 2,
  message: AgentMessage(
    id: 'report',
    type: AgentMessageType.modelOutput,
    raw: {'type': 'model-output', 'text': text, 'final': true},
  ),
);

Widget _subject(
  _SearchClient client, {
  String text = '`notes.md`',
  bool wide = false,
  Brightness brightness = Brightness.light,
  List<WireEvent> before = const [],
}) {
  final spec = themeSpecById(kDefaultThemeId);
  return RepaintBoundary(
    key: _captureKey,
    child: buildSessionDetailTestPage(
      brokerClient: client,
      events: [...before, _report(text)],
      withRouter: !wide,
      embedded: wide,
      theme: buildAppTheme(
        brightness == Brightness.light ? spec.light : spec.dark,
        brightness,
      ),
      homeBuilder: wide
          ? (page) => Scaffold(
              body: SidePaneScope(
                available: true,
                expand: () {},
                child: Row(
                  children: [
                    Expanded(child: page),
                    const SizedBox(
                      width: 520,
                      child: FilePaneSurface(session: _session),
                    ),
                  ],
                ),
              ),
            )
          : null,
    ),
  );
}

Future<void> _openMention(WidgetTester tester, String text) async {
  await tester.tap(find.byKey(ValueKey('transcript-file-mention-$text')));
  await tester.pumpAndSettle();
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
    await (FontLoader(
      'Lato',
    )..addFont(rootBundle.load('assets/fonts/Lato-Regular.ttf'))).load();
  });

  testWidgets(
    'a Pi-style report table resolves a known basename with tools hidden',
    (tester) async {
      final client = _SearchClient()
        ..paths['/workspace/transfer/PLAN.md'] = 'transfer/PLAN.md'
        ..paths['transfer/PLAN.md'] = 'transfer/PLAN.md';
      await tester.pumpWidget(
        _subject(
          client,
          text: '| File |\n|---|\n| `PLAN.md` |',
          before: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.toolResult,
                raw: {
                  'type': 'tool-result',
                  'callId': 'write-plan',
                  'path': '/workspace/transfer/PLAN.md',
                },
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();
      await toggleSessionDetailViewOption(tester, 'report');
      await _openMention(tester, 'PLAN.md');
      expect(client.queries, isEmpty);
      expect(client.fsReadPaths, ['transfer/PLAN.md']);
      expect(find.text('file route transfer/PLAN.md#null'), findsOneWidget);
    },
  );

  testWidgets(
    'selected plain text offers workspace search and opens the single match',
    (tester) async {
      final client = _SearchClient(matches: ['transfer/notes'])
        ..paths['transfer/notes'] = 'transfer/notes';
      await tester.pumpWidget(_subject(client, text: 'notes'));
      await tester.pumpAndSettle();
      await tester.longPress(find.text('notes'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Find file in workspace'));
      await tester.pumpAndSettle();
      expect(client.queries, ['notes']);
      expect(client.fsReadPaths, ['transfer/notes']);
    },
  );

  for (final modifier in [
    LogicalKeyboardKey.controlLeft,
    LogicalKeyboardKey.metaLeft,
  ]) {
    testWidgets('${modifier.keyLabel}-click searches selected plain text', (
      tester,
    ) async {
      final client = _SearchClient(matches: ['transfer/notes'])
        ..paths['transfer/notes'] = 'transfer/notes';
      await tester.pumpWidget(_subject(client, text: 'notes'));
      await tester.pumpAndSettle();
      await tester.longPress(find.text('notes'));
      await tester.pumpAndSettle();
      await tester.sendKeyDownEvent(modifier);
      await tester.tap(find.text('notes'));
      await tester.sendKeyUpEvent(modifier);
      await tester.pumpAndSettle();
      expect(client.queries, ['notes']);
      expect(client.fsReadPaths, ['transfer/notes']);
    });
  }

  for (final brightness in Brightness.values) {
    testWidgets(
      'ambiguous file chooser opens the chosen right tab in ${brightness.name}',
      (tester) async {
        await tester.binding.setSurfaceSize(const Size(1440, 900));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final client = _SearchClient(
          matches: ['transfer/notes.md', 'archive/notes.md'],
        )..paths['transfer/notes.md'] = 'transfer/notes.md';
        await tester.pumpWidget(
          _subject(client, wide: true, brightness: brightness),
        );
        await tester.pumpAndSettle();
        await _openMention(tester, 'notes.md');
        expect(client.fsReadPaths, isEmpty);
        expect(find.text('Choose a file to open.'), findsOneWidget);
        await _capture(tester, 'search-${brightness.name}');
        await tester.tap(
          find.byKey(
            const ValueKey('session-file-search-match-transfer/notes.md'),
          ),
        );
        await tester.pumpAndSettle();
        expect(client.fsReadPaths, contains('transfer/notes.md'));
        expect(find.byKey(const Key('file-tabs-strip')), findsOneWidget);
        expect(
          find.byKey(const Key('session-detail-tab-panel-chat')),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets('modified clicks outside selected text keep their own action', (
    tester,
  ) async {
    final client = _SearchClient();
    final urls = <Uri>[];
    transcriptLinkOpener = urls.add;
    addTearDown(() => transcriptLinkOpener = null);
    await tester.pumpWidget(
      _subject(client, text: 'notes\n\n[website](https://example.com)'),
    );
    await tester.pumpAndSettle();
    await tester.longPress(find.text('notes'));
    await tester.pumpAndSettle();
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.tap(find.text('website'));
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pumpAndSettle();
    expect(urls, [Uri.parse('https://example.com')]);
    expect(client.queries, isEmpty);
    await tester.longPress(find.text('notes'));
    await tester.pumpAndSettle();
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.tap(
      find.text('notes'),
      buttons: kSecondaryMouseButton,
      kind: ui.PointerDeviceKind.mouse,
    );
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pumpAndSettle();
    expect(client.queries, isEmpty);
  });

  testWidgets('small drag steps cancel modified file activation', (
    tester,
  ) async {
    final client = _SearchClient();
    await tester.pumpWidget(_subject(client, text: 'notes'));
    await tester.pumpAndSettle();
    await tester.longPress(find.text('notes'));
    await tester.pumpAndSettle();
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    final position = tester.getCenter(find.text('notes'));
    final gesture = await tester.startGesture(
      position,
      kind: ui.PointerDeviceKind.mouse,
    );
    for (var step = 1; step <= 12; step++) {
      await gesture.moveTo(position + Offset(step.toDouble(), 0));
    }
    await gesture.up();
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await tester.pumpAndSettle();
    expect(client.queries, isEmpty);
  });

  testWidgets(
    'Open folder resolves a report basename before choosing its parent',
    (tester) async {
      final client = _SearchClient(matches: ['transfer/notes.md'])
        ..paths['transfer/notes.md'] = 'transfer/notes.md';
      await tester.pumpWidget(_subject(client));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('transcript-file-mention-notes.md')),
        buttons: kSecondaryMouseButton,
        kind: ui.PointerDeviceKind.mouse,
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const Key('transcript-file-link-open-folder')),
      );
      await tester.pumpAndSettle();
      expect(client.queries, ['notes.md']);
      expect(client.fsListedPaths.last, 'transfer');
      expect(client.fsReadPaths, isEmpty);
    },
  );

  testWidgets('changing broker profile discards a pending file search result', (
    tester,
  ) async {
    final pending = Completer<FsSearchResult>();
    final client = _SearchClient()..pending = pending;
    await tester.pumpWidget(_subject(client));
    await tester.pumpAndSettle();
    final container = ProviderScope.containerOf(
      tester.element(find.byType(SelectionArea).first),
    );
    await tester.tap(
      find.byKey(const ValueKey('transcript-file-mention-notes.md')),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    container.read(activeBrokerProfileProvider.notifier).state = null;
    await tester.pump();
    pending.complete(
      FsSearchResult(query: 'notes.md', matches: [_node('transfer/notes.md')]),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 500));
    expect(client.fsReadPaths, isEmpty);
    expect(find.byKey(const Key('session-file-search-dialog')), findsNothing);
  });

  testWidgets(
    'a partial single result requires choosing, and no matches explains itself',
    (tester) async {
      final client = _SearchClient(
        matches: ['transfer/notes.md'],
        partial: true,
      );
      await tester.pumpWidget(_subject(client));
      await tester.pumpAndSettle();
      await _openMention(tester, 'notes.md');
      expect(find.textContaining('Search reached its limit'), findsOneWidget);
      expect(client.fsReadPaths, isEmpty);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
      await tester.pumpWidget(_subject(_SearchClient()));
      await tester.pumpAndSettle();
      await _openMention(tester, 'notes.md');
      expect(find.text('No matching files found.'), findsOneWidget);
    },
  );

  testWidgets('cancelling an in-flight search cannot open its late result', (
    tester,
  ) async {
    final pending = Completer<FsSearchResult>();
    final client = _SearchClient()..pending = pending;
    await tester.pumpWidget(_subject(client));
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('transcript-file-mention-notes.md')),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();
    pending.complete(
      FsSearchResult(query: 'notes.md', matches: [_node('transfer/notes.md')]),
    );
    await tester.pumpAndSettle();
    expect(client.fsReadPaths, isEmpty);
    expect(find.byKey(const Key('session-file-search-dialog')), findsNothing);
  });
}
