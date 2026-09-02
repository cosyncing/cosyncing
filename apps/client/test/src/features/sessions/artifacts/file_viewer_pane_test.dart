import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_viewer_pane.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_file_browser.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

SessionFilePreview _preview({
  String text = 'alpha\nbeta\ngamma',
  int? anchorLine,
  bool truncated = false,
  int size = 40,
}) => SessionFilePreview(
  path: 'lib/a.dart',
  displayName: 'a.dart',
  mimeType: 'text/x-dart; charset=utf-8',
  size: size,
  limit: 1024 * 1024,
  truncated: truncated,
  text: text,
  anchorLine: anchorLine,
);

SessionFilePreview _markdown({required String text}) => SessionFilePreview(
  path: 'docs/notes.md',
  displayName: 'notes.md',
  mimeType: 'text/markdown',
  size: text.length,
  limit: 1024 * 1024,
  truncated: false,
  text: text,
);

Widget _host(
  FileViewerContent content, {
  Brightness brightness = Brightness.light,
  Locale locale = const Locale('en'),
  VoidCallback? onClose,
  VoidCallback? onRetry,
}) {
  final spec = themeSpecById(kDefaultThemeId);
  return MaterialApp(
    locale: locale,
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    theme: ThemeData(
      brightness: brightness,
      extensions: [
        if (brightness == Brightness.dark) spec.dark else spec.light,
      ],
    ),
    home: Scaffold(
      body: SizedBox(
        width: 700,
        height: 400,
        child: FileViewerPane(
          content: content,
          sessionLabel: 'codex · refactor auth',
          toolColor: spec.light.toolCodex,
          onClose: onClose,
          onRetry: onRetry,
        ),
      ),
    ),
  );
}

void main() {
  group('FileViewerPane', () {
    testWidgets('holds no ticker — a file is never busy', (tester) async {
      await tester.pumpWidget(_host(FileViewerSource(preview: _preview())));
      await tester.pump();
      // The behaviour contract from the design: no pulse, no spinner, no
      // animation of any kind. A ticker here is the first way that breaks.
      expect(tester.binding.transientCallbackCount, 0);
      expect(find.byType(CircularProgressIndicator), findsNothing);
      expect(find.byType(LinearProgressIndicator), findsNothing);
    });

    testWidgets('loading is a skeleton, never a spinner', (tester) async {
      await tester.pumpWidget(
        _host(
          const FileViewerReading(path: 'lib/a.dart', displayName: 'a.dart'),
        ),
      );
      await tester.pump();
      expect(find.byKey(const Key('file-viewer-skeleton')), findsOneWidget);
      expect(find.byType(CircularProgressIndicator), findsNothing);
      // The header has already painted, so the name and path do not pop in.
      expect(find.byKey(const Key('file-viewer-name')), findsOneWidget);
      expect(find.byKey(const Key('file-viewer-path')), findsOneWidget);
      expect(tester.binding.transientCallbackCount, 0);
    });

    testWidgets('the header stays put while the body scrolls', (tester) async {
      final lines = List<String>.generate(400, (i) => 'line $i');
      await tester.pumpWidget(
        _host(FileViewerSource(preview: _preview(text: lines.join('\n')))),
      );
      await tester.pump();
      expect(find.byKey(const Key('file-viewer-name')), findsOneWidget);

      await tester.drag(
        find.byKey(const Key('file-viewer-lines')),
        const Offset(0, -2000),
      );
      await tester.pump();

      // Defect 5 in the spec: the dialog's metadata scrolled away and left no
      // header. Nothing in this header may scroll.
      expect(find.byKey(const Key('file-viewer-name')), findsOneWidget);
      expect(find.byKey(const Key('file-viewer-path')), findsOneWidget);
      expect(find.byKey(const Key('file-viewer-read-only')), findsOneWidget);
    });

    testWidgets('the gutter is pinned and the long line reaches its end', (
      tester,
    ) async {
      final wide = 'x' * 400;
      await tester.pumpWidget(
        _host(FileViewerSource(preview: _preview(text: 'short\n$wide'))),
      );
      await tester.pump();

      final pane = tester.getRect(find.byKey(const Key('file-viewer-pane')));
      final gutterBefore = tester.getTopLeft(
        find.byKey(const Key('file-viewer-gutter')),
      );
      // The premise: this line really does run off the right edge, so the
      // assertions below are about scrolling rather than about a short line.
      expect(
        tester.getRect(find.text(wide)).right,
        greaterThan(pane.right),
      );

      // Drag the pane, not the code list: the list is wider than the viewport,
      // so its own centre sits in the clipped region and a drag aimed there
      // silently misses.
      await tester.drag(
        find.byKey(const Key('file-viewer-pane')),
        const Offset(-5000, 0),
      );
      await tester.pump();

      // D-3: one horizontal axis for the whole body, and the gutter is not on
      // it. Per-line scrolling would destroy the column alignment that is the
      // entire point of having a gutter.
      expect(
        tester.getTopLeft(find.byKey(const Key('file-viewer-gutter'))),
        gutterBefore,
      );

      // contentWidth is a measured monospace advance, not an estimate, so the
      // end of the longest line lands its trailing pad from the edge. Under-
      // measure and the tail is unreachable; over-measure and the pane scrolls
      // into empty space. The tolerance is for the per-glyph pixel hack in
      // TextPainter.width, which rounds up and so accumulates a fraction of a
      // pixel of slack over a long line — erring the safe way.
      expect(
        pane.right - tester.getRect(find.text(wide)).right,
        closeTo(16.0, 1.0),
      );
    });

    testWidgets('the anchor is carried by the gutter, with no row wash', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(FileViewerSource(preview: _preview(anchorLine: 2))),
      );
      await tester.pump();

      final tokens = themeSpecById(kDefaultThemeId).light;
      final number = tester.widget<Text>(
        find.byKey(const Key('file-viewer-anchor-number')),
      );
      expect(number.style?.color, tokens.accent);
      final edge = tester.widget<Container>(
        find.byKey(const Key('file-viewer-anchor-edge')),
      );
      expect(
        edge.color ?? (edge.decoration as BoxDecoration?)?.color,
        tokens.accent,
      );

      // accentSurface must never end up behind highlighted code: four light
      // themes have no headroom over the 4.5:1 syntax bar. If a wash is ever
      // re-added, this is where it gets caught.
      final washed = find.byWidgetPredicate(
        (w) => w is ColoredBox && w.color == tokens.accentSurface,
      );
      expect(washed, findsNothing);
    });

    testWidgets('wrap is offered on source and drops the pinned gutter', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(FileViewerSource(preview: _preview(text: 'a' * 300))),
      );
      await tester.pump();
      expect(find.byKey(const Key('file-viewer-gutter')), findsOneWidget);

      await tester.tap(find.byKey(const Key('file-viewer-wrap')));
      await tester.pump();

      // Wrapped text has no horizontal axis, so there is nothing to pin a
      // separate gutter column against; the numbers ride beside their block.
      expect(find.byKey(const Key('file-viewer-gutter')), findsNothing);
      expect(find.byKey(const Key('file-viewer-lines')), findsOneWidget);
    });

    testWidgets('a truncated read says so above the body', (tester) async {
      await tester.pumpWidget(
        _host(
          FileViewerSource(
            preview: _preview(truncated: true, size: 4000000),
          ),
        ),
      );
      await tester.pump();
      expect(find.byKey(const Key('file-viewer-truncated')), findsOneWidget);
      // Names the lines that arrived and nothing else. A byte-capped read
      // carries the file's size but not its line count, so "the first 3 of
      // 183,204 lines" would be a number the client invented.
      expect(find.textContaining('first 3 lines'), findsOneWidget);
      expect(find.textContaining('of 3 lines'), findsNothing);
    });

    testWidgets('wrap is not offered on a state panel', (tester) async {
      await tester.pumpWidget(
        _host(const FileViewerGone(path: 'lib/a.dart', displayName: 'a.dart')),
      );
      await tester.pump();
      expect(find.byKey(const Key('file-viewer-wrap')), findsNothing);
      expect(find.byKey(const Key('file-viewer-copy')), findsNothing);
    });

    testWidgets('a gone file keeps its path and offers a way back', (
      tester,
    ) async {
      var retried = 0;
      await tester.pumpWidget(
        _host(
          const FileViewerGone(path: 'lib/a.dart', displayName: 'a.dart'),
          onRetry: () => retried++,
        ),
      );
      await tester.pump();
      expect(find.byKey(const Key('file-viewer-gone')), findsOneWidget);
      expect(find.text('This file is gone'), findsOneWidget);
      // The tab never silently disappears, so the path must still be readable
      // — in the header, and again in the panel where it can be copied.
      expect(find.text('lib/a.dart'), findsNWidgets(2));
      // The panel's copyable path brings an EditableText with it; its cursor
      // ticker must stay unstarted, or a gone file quietly animates forever.
      // Asserted before the tap, since a button ripple is a real animation.
      expect(tester.binding.transientCallbackCount, 0);
      await tester.tap(find.text('Try again'));
      expect(retried, 1);
    });

    testWidgets('binary content is named, never rendered as mojibake', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          const FileViewerUnsupported(
            path: 'assets/logo.png',
            displayName: 'logo.png',
            typeLabel: 'image/png',
            size: 48000,
          ),
        ),
      );
      await tester.pump();
      expect(find.byKey(const Key('file-viewer-unsupported')), findsOneWidget);
      expect(find.textContaining('image/png'), findsOneWidget);
      expect(find.byKey(const Key('file-viewer-lines')), findsNothing);
    });

    testWidgets('a closed gate is a panel, not a toast', (tester) async {
      await tester.pumpWidget(
        _host(
          const FileViewerGateClosed(
            path: 'lib/a.dart',
            displayName: 'a.dart',
            explanation: 'Enable features.httpWorkspaceBrowsing and restart.',
          ),
        ),
      );
      await tester.pump();
      expect(find.byKey(const Key('file-viewer-gate-closed')), findsOneWidget);
      expect(
        find.textContaining('features.httpWorkspaceBrowsing'),
        findsOneWidget,
      );
      expect(find.byType(SnackBar), findsNothing);
    });

    testWidgets('selection covers the body and never the chrome', (
      tester,
    ) async {
      await tester.pumpWidget(_host(FileViewerSource(preview: _preview())));
      await tester.pump();

      // The chrome sits under SelectionContainer.disabled so a drag that
      // starts on source cannot pull a header row in with it.
      expect(
        find.ancestor(
          of: find.byKey(const Key('file-viewer-name')),
          matching: find.byType(SelectionContainer),
        ),
        findsWidgets,
      );
      expect(
        find.ancestor(
          of: find.byKey(const Key('file-viewer-lines')),
          matching: find.byType(SelectionArea),
        ),
        findsOneWidget,
      );
    });

    testWidgets('a source language is highlighted and named', (tester) async {
      await tester.pumpWidget(
        _host(
          FileViewerSource(
            preview: _preview(text: "final a = 'b'; // c"),
          ),
        ),
      );
      await tester.pump();

      // The chip is the renderer identity, not decoration.
      final chip = tester.widget<MetadataChip>(
        find.byKey(const Key('file-viewer-renderer')),
      );
      expect(chip.label, 'dart');

      final rich = tester
          .widgetList<Text>(
            find.descendant(
              of: find.byKey(const Key('file-viewer-lines')),
              matching: find.byType(Text),
            ),
          )
          .where((text) => text.textSpan != null);
      expect(rich, isNotEmpty);
      expect(
        find.byKey(const Key('file-viewer-highlighting-off')),
        findsNothing,
      );
    });

    testWidgets('a declined line says so, and shows no syntax spans', (
      tester,
    ) async {
      // One line of ~5,200 alternating runs: past the token bound, far under
      // the 128 KB units bound. D-10's case -- the text is complete and must
      // say so, rather than arriving as undifferentiated grey with no signal.
      // Identifier/string alternation, because digits are identifier-part
      // characters, so `a1a1...` would lex as one run and decline nothing.
      await tester.pumpWidget(
        _host(
          FileViewerSource(
            preview: _preview(text: 'final a = 1;\n${'a"x"' * 2600}'),
          ),
        ),
      );
      await tester.pump();

      expect(
        find.byKey(const Key('file-viewer-highlighting-off')),
        findsOneWidget,
      );
      expect(find.textContaining('complete'), findsOneWidget);
      final rich = tester
          .widgetList<Text>(
            find.descendant(
              of: find.byKey(const Key('file-viewer-lines')),
              matching: find.byType(Text),
            ),
          )
          .where((text) => text.textSpan != null);
      expect(rich, isEmpty);
    });

    testWidgets('markdown offers both faces and code offers one', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(FileViewerSource(preview: _preview())),
      );
      await tester.pump();
      expect(find.byKey(const Key('file-viewer-mode-source')), findsNothing);

      await tester.pumpWidget(
        _host(
          FileViewerSource(
            preview: _markdown(text: '# Title\n\nBody text.'),
          ),
        ),
      );
      await tester.pump();
      expect(find.byKey(const Key('file-viewer-mode-source')), findsOneWidget);
      expect(
        find.byKey(const Key('file-viewer-mode-rendered')),
        findsOneWidget,
      );
      // Source is the default everywhere, so raw markdown is what opens.
      expect(find.byKey(const Key('file-viewer-lines')), findsOneWidget);
      expect(find.text('# Title'), findsOneWidget);
    });

    testWidgets('wrap is withdrawn in a rendered view', (tester) async {
      await tester.pumpWidget(
        _host(
          FileViewerSource(
            preview: _markdown(text: '# Title\n\nBody text.'),
          ),
        ),
      );
      await tester.pump();
      expect(find.byKey(const Key('file-viewer-wrap')), findsOneWidget);

      await tester.tap(find.byKey(const Key('file-viewer-mode-rendered')));
      await tester.pump();

      // A rendered view reflows on its own; offering wrap there would be a
      // control that does nothing, and on a rendered diff it would lie.
      expect(find.byKey(const Key('file-viewer-wrap')), findsNothing);
      expect(find.byKey(const Key('file-viewer-rendered')), findsOneWidget);
      expect(find.byKey(const Key('file-viewer-lines')), findsNothing);
      expect(find.text('# Title'), findsNothing);
      expect(find.text('Title'), findsOneWidget);
    });

    testWidgets('a mode switch still holds no ticker', (tester) async {
      await tester.pumpWidget(
        _host(FileViewerSource(preview: _markdown(text: '# Title'))),
      );
      await tester.pump();
      await tester.tap(find.byKey(const Key('file-viewer-mode-rendered')));
      await tester.pumpAndSettle();
      expect(tester.binding.transientCallbackCount, 0);
      expect(find.byType(CircularProgressIndicator), findsNothing);
    });

    testWidgets('renders in zh without a hard-coded English string', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          const FileViewerGone(path: 'lib/a.dart', displayName: 'a.dart'),
          locale: const Locale('zh'),
          brightness: Brightness.dark,
        ),
      );
      await tester.pump();
      expect(find.text('该文件已不存在'), findsOneWidget);
      expect(find.text('This file is gone'), findsNothing);
    });
  });
}
