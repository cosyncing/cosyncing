import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_renderers.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_viewer_pane.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_file_browser.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const String _patch = '''
diff --git a/lib/a.dart b/lib/a.dart
--- a/lib/a.dart
+++ b/lib/a.dart
@@ -1,4 +1,5 @@
 const keep = 1;
-const gone = 2;
+const added = 2;
+const alsoAdded = 3;
 const tail = 4;
''';

SessionFilePreview _diffPreview([String text = _patch]) => SessionFilePreview(
  path: 'work/change.diff',
  displayName: 'change.diff',
  mimeType: 'text/x-diff',
  size: text.length,
  limit: 1024 * 1024,
  truncated: false,
  text: text,
);

Widget _host(
  SessionFilePreview preview, {
  FilePaneView? initialView,
  ValueChanged<FilePaneView>? onViewChanged,
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
          sessionLabel: 'codex · patch',
          toolColor: spec.light.toolCodex,
          initialView: initialView,
          onViewChanged: onViewChanged,
        ),
      ),
    ),
  );
}

void main() {
  group('a resumed read', () {
    testWidgets('opens on the handed-over face, not the default one', (
      tester,
    ) async {
      // A patch is the one file that defaults to rendered, so it is the only
      // fixture where "the handed-over face won" is distinguishable from
      // "nothing happened".
      await tester.pumpWidget(
        _host(
          _diffPreview(),
          initialView: (mode: FileViewMode.source, offset: 0),
        ),
      );
      await tester.pump();

      expect(find.byKey(const Key('file-viewer-lines')), findsOneWidget);
      expect(find.byKey(const Key('file-viewer-diff')), findsNothing);
    });

    testWidgets('reports the face it was switched to', (tester) async {
      final reported = <FilePaneView>[];
      await tester.pumpWidget(
        _host(_diffPreview(), onViewChanged: reported.add),
      );
      await tester.pump();

      await tester.tap(find.byKey(const Key('file-viewer-mode-source')));
      await tester.pump();

      // Without this the crossing would resume on the renderer's default face
      // and silently undo the reader's choice.
      expect(reported.last.mode, FileViewMode.source);
    });
  });

  group('rendered diff', () {
    testWidgets('a patch opens rendered, unlike every other file', (
      tester,
    ) async {
      await tester.pumpWidget(_host(_diffPreview()));
      await tester.pump();

      // The one renderer where presentation, not bytes, is the point.
      expect(find.byKey(const Key('file-viewer-diff')), findsOneWidget);
      expect(find.byKey(const Key('file-viewer-lines')), findsNothing);
      expect(tester.binding.transientCallbackCount, 0);
    });

    testWidgets('each file section names its path and its counts', (
      tester,
    ) async {
      await tester.pumpWidget(_host(_diffPreview()));
      await tester.pump();
      expect(find.byKey(const Key('file-viewer-diff-file')), findsOneWidget);
      expect(find.textContaining('lib/a.dart'), findsWidgets);
      expect(find.byKey(const Key('file-viewer-diff-hunk')), findsOneWidget);
      expect(find.textContaining('@@ -1,4 +1,5 @@'), findsOneWidget);
    });

    testWidgets('added and removed rows use the existing diff tokens', (
      tester,
    ) async {
      await tester.pumpWidget(_host(_diffPreview()));
      await tester.pump();
      final tokens = themeSpecById(kDefaultThemeId).light;

      final surfaces = tester
          .widgetList<Container>(
            find.descendant(
              of: find.byKey(const Key('file-viewer-diff')),
              matching: find.byType(Container),
            ),
          )
          .map((container) => container.color)
          .toList();
      // Zero new tokens: the rendered diff paints on the same four the
      // transcript's inline diff already uses.
      expect(surfaces, contains(tokens.diffAddSurface));
      expect(surfaces, contains(tokens.diffRemoveSurface));
    });

    testWidgets('the gutter carries both old and new numbers', (tester) async {
      await tester.pumpWidget(_host(_diffPreview()));
      await tester.pump();
      final gutter = find.byKey(const Key('file-viewer-diff-gutter'));
      expect(gutter, findsOneWidget);
      // A removal has an old number and no new one; an addition the reverse.
      expect(
        find.descendant(of: gutter, matching: find.text('2')),
        findsWidgets,
      );
    });

    testWidgets('source is one tap away and wrap returns with it', (
      tester,
    ) async {
      await tester.pumpWidget(_host(_diffPreview()));
      await tester.pump();
      // No wrap in the rendered face: a wrapped diff is a broken diff, since a
      // continuation line is indistinguishable from a context line once the
      // +/- column has moved.
      expect(find.byKey(const Key('file-viewer-wrap')), findsNothing);

      await tester.tap(find.byKey(const Key('file-viewer-mode-source')));
      await tester.pump();

      expect(find.byKey(const Key('file-viewer-diff')), findsNothing);
      expect(find.byKey(const Key('file-viewer-lines')), findsOneWidget);
      expect(find.byKey(const Key('file-viewer-wrap')), findsOneWidget);
      expect(find.textContaining('-const gone = 2;'), findsOneWidget);
    });

    testWidgets('text that is not a patch still renders as text', (
      tester,
    ) async {
      await tester.pumpWidget(_host(_diffPreview('just some prose\nand more')));
      await tester.pump();
      // A .diff that does not parse must not come back blank.
      expect(find.textContaining('just some prose'), findsOneWidget);
    });
  });
}
