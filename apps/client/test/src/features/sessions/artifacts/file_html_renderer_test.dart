import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_html_renderer.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_html_view.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_renderers.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_viewer_pane.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_file_browser.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const String _page = '''
<html>
  <body><h1>Coverage</h1></body>
</html>
''';

SessionFilePreview _html([String text = _page]) => SessionFilePreview(
  path: 'docs/coverage.html',
  displayName: 'coverage.html',
  mimeType: 'text/html',
  size: text.length,
  limit: 1024 * 1024,
  truncated: false,
  text: text,
);

Widget _host(
  SessionFilePreview preview, {
  Future<bool> Function()? onOpenExternally,
}) {
  final spec = themeSpecById(kDefaultThemeId);
  return MaterialApp(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    theme: ThemeData(extensions: [spec.light]),
    home: Scaffold(
      body: SizedBox(
        width: 800,
        height: 420,
        child: FileViewerPane(
          content: FileViewerSource(preview: preview),
          sessionLabel: 'codex · coverage',
          toolColor: spec.light.toolCodex,
          onOpenExternally: onOpenExternally,
        ),
      ),
    ),
  );
}

void main() {
  group('the HTML renderer', () {
    test('claims HTML by extension and by type', () {
      final descriptor = htmlFileRenderer();
      expect(descriptor.id, htmlFileRendererId);
      expect(descriptor.extensions, containsAll(['html', 'htm', 'xhtml']));
      expect(descriptor.mimeTypes, contains('text/html'));
      // Source is the default on every platform: the bytes are what was asked
      // for, and a rendered page is the interpretation of them.
      expect(descriptor.defaultMode, FileViewMode.source);
    });

    test('offers a rendered face only where a pane can hold one', () {
      final descriptor = htmlFileRenderer();
      if (canRenderHtmlInPane) {
        expect(descriptor.modes, contains(FileViewMode.rendered));
        expect(descriptor.granted, contains(FileRenderCapability.passiveFrame));
      } else {
        // Absent, not disabled: no control should suggest an affordance the
        // platform cannot deliver.
        expect(descriptor.modes, {FileViewMode.source});
        expect(descriptor.granted, isEmpty);
      }
    });

    testWidgets('an HTML file opens on source', (tester) async {
      await tester.pumpWidget(_host(_html()));
      await tester.pump();

      expect(find.byKey(const Key('file-viewer-lines')), findsOneWidget);
      expect(find.byKey(const Key('file-viewer-html')), findsNothing);
      // Markup read literally: highlighting belongs to the code renderer.
      expect(find.textContaining('<h1>Coverage</h1>'), findsOneWidget);
    });

    testWidgets('the toggle and the notice follow the platform', (
      tester,
    ) async {
      await tester.pumpWidget(_host(_html()));
      await tester.pump();

      if (canRenderHtmlInPane) {
        expect(
          find.byKey(const Key('file-viewer-mode-rendered')),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('file-viewer-html-source-only')),
          findsNothing,
        );
      } else {
        expect(
          find.byKey(const Key('file-viewer-mode-rendered')),
          findsNothing,
        );
        expect(
          find.byKey(const Key('file-viewer-html-source-only')),
          findsOneWidget,
        );
      }
    });

    testWidgets('a source-only platform offers the labelled hand-off', (
      tester,
    ) async {
      if (canRenderHtmlInPane) return;
      var asked = 0;
      await tester.pumpWidget(
        _host(
          _html(),
          onOpenExternally: () async {
            asked++;
            return true;
          },
        ),
      );
      await tester.pump();

      // A dead end with no escape hatch does not serve the reader.
      await tester.tap(find.byKey(const Key('file-viewer-open-in-browser')));
      await tester.pump();
      expect(asked, 1);
    });

    testWidgets('a hand-off that did not open says so', (tester) async {
      if (canRenderHtmlInPane) return;
      await tester.pumpWidget(
        _host(_html(), onOpenExternally: () async => false),
      );
      await tester.pump();

      await tester.tap(find.byKey(const Key('file-viewer-open-in-browser')));
      await tester.pump();
      await tester.pump();

      // Silence would read as "it opened somewhere you cannot see".
      expect(
        find.byKey(const Key('file-viewer-open-in-browser-failed')),
        findsOneWidget,
      );
    });

    testWidgets('with nowhere to hand off to, no action is drawn', (
      tester,
    ) async {
      if (canRenderHtmlInPane) return;
      await tester.pumpWidget(_host(_html()));
      await tester.pump();

      expect(
        find.byKey(const Key('file-viewer-html-source-only')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('file-viewer-open-in-browser')),
        findsNothing,
      );
    });
  });
}
