import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/design/ui_scale.dart';
// The canonical renderer import exceeds the style line width; keep the stable
// package path for boundary-safe package import resolution.
// ignore: lines_longer_than_80_chars
import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/transcript_markdown.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

Future<void> _pumpBody(WidgetTester tester, String text) async {
  await tester.pumpWidget(
    MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(
        body: Builder(
          builder: (context) => buildAgentMessageRenderer(
            context,
            AgentMessage.fromJson({'type': 'model-output', 'text': text}),
          ),
        ),
      ),
    ),
  );
}

/// Returns the style of the inline run whose text equals [runText] inside the
/// rich [Text] found by [richFinder], or null when no such run exists.
TextStyle? _runStyle(WidgetTester tester, Finder richFinder, String runText) {
  final span = tester.widget<Text>(richFinder).textSpan;
  TextStyle? found;
  span?.visitChildren((child) {
    if (child is TextSpan && child.text == runText) {
      found = child.style;
      return false;
    }
    return true;
  });
  return found;
}

void main() {
  group('transcript markdown links (web-only)', () {
    testWidgets('an https link is tappable and launches via the opener', (
      tester,
    ) async {
      final opened = <Uri>[];
      transcriptLinkOpener = opened.add;
      addTearDown(() => transcriptLinkOpener = null);

      await _pumpBody(tester, 'see [the site](https://example.com/a) now');

      // The link label renders as its own tappable Text (not inline prose).
      final label = find.text('the site');
      expect(label, findsOneWidget);
      // It looks like a link.
      expect(
        tester.widget<Text>(label).style?.decoration,
        TextDecoration.underline,
      );

      await tester.tap(label);
      await tester.pump();
      expect(opened, [Uri.parse('https://example.com/a')]);
    });

    testWidgets('a /home path link exposes its exact target with no gesture', (
      tester,
    ) async {
      final opened = <Uri>[];
      transcriptLinkOpener = opened.add;
      addTearDown(() => transcriptLinkOpener = null);

      await _pumpBody(tester, 'open [the file](/var/data/file) here');

      final prose = find.textContaining('open the file (/var/data/file) here');
      expect(prose, findsOneWidget);
      // It is not styled as a link.
      final style = _runStyle(tester, prose, 'the file');
      expect(style?.decoration, isNot(TextDecoration.underline));
      expect(
        tester.widget<Text>(prose).textSpan!.toPlainText(),
        'open the file (/var/data/file) here',
      );
      // Tapping the prose opens nothing.
      await tester.tap(prose);
      await tester.pump();
      expect(opened, isEmpty);
    });

    testWidgets('a file:// link is not tappable and not styled as a link', (
      tester,
    ) async {
      final opened = <Uri>[];
      transcriptLinkOpener = opened.add;
      addTearDown(() => transcriptLinkOpener = null);

      await _pumpBody(tester, 'read [notes](file:///etc/hosts) please');

      final prose = find.textContaining(
        'read notes (file:///etc/hosts) please',
      );
      expect(prose, findsOneWidget);
      expect(
        _runStyle(tester, prose, 'notes')?.decoration,
        isNot(TextDecoration.underline),
      );

      await tester.tap(prose);
      await tester.pump();
      expect(opened, isEmpty);
    });

    testWidgets('a matching non-http label and target renders only once', (
      tester,
    ) async {
      await _pumpBody(tester, 'open [/repo/README.md](/repo/README.md) now');

      final prose = find.textContaining('open /repo/README.md now');
      expect(prose, findsOneWidget);
      expect(
        tester.widget<Text>(prose).textSpan!.toPlainText(),
        'open /repo/README.md now',
      );
    });
  });

  group('transcript markdown tables', () {
    testWidgets('a pipe table renders cells in a horizontal scroller', (
      tester,
    ) async {
      await _pumpBody(
        tester,
        '| Name | Role |\n|---|---|\n| Ada | Eng |\n| Bob | PM |',
      );

      expect(find.byType(Table), findsOneWidget);
      expect(find.textContaining('Name'), findsOneWidget);
      expect(find.textContaining('Ada'), findsOneWidget);
      expect(find.textContaining('PM'), findsOneWidget);

      // The table lives inside a horizontally scrollable container so a wide
      // table scrolls rather than overflowing the transcript width.
      final scroller = tester.widget<SingleChildScrollView>(
        find.ancestor(
          of: find.byType(Table),
          matching: find.byType(SingleChildScrollView),
        ),
      );
      expect(scroller.scrollDirection, Axis.horizontal);
    });

    testWidgets('an https link inside a table cell is tappable', (
      tester,
    ) async {
      final opened = <Uri>[];
      transcriptLinkOpener = opened.add;
      addTearDown(() => transcriptLinkOpener = null);

      await _pumpBody(
        tester,
        '| Doc |\n|---|\n| [open](https://example.org) |',
      );

      expect(find.byType(Table), findsOneWidget);
      final label = find.text('open');
      expect(label, findsOneWidget);

      await tester.tap(label);
      await tester.pump();
      expect(opened, [Uri.parse('https://example.org')]);
    });

    testWidgets('malformed table-like input renders without throwing', (
      tester,
    ) async {
      await _pumpBody(tester, '| A | B |\n| 1 | 2 |');
      // No valid delimiter row: the lines stay prose, no Table is built.
      expect(find.byType(Table), findsNothing);
      expect(tester.takeException(), isNull);
    });
  });

  group('transcript fenced-code highlighting', () {
    // One fence exercising every scanner category: keyword, string, number,
    // comment, and built-in literal.
    const allCategoriesFence =
        '```dart\nfinal answer = "s" + 42; // exact\ntrue\n```';
    const allCategoriesSource = 'final answer = "s" + 42; // exact\ntrue';

    TextSpan runOf(Text code, String runText) {
      final root = code.textSpan! as TextSpan;
      return root.children!.whereType<TextSpan>().singleWhere(
        (span) => span.text == runText,
      );
    }

    for (final brightness in Brightness.values) {
      for (final density in [UiDensity.compact, UiDensity.spacious]) {
        testWidgets(
          'every category uses its dedicated syntax token in '
          '${brightness.name} ${density.name} mode',
          (tester) async {
            final theme = await _pumpMarkdown(
              tester,
              allCategoriesFence,
              brightness: brightness,
              density: density,
              viewSize: const Size(320, 480),
            );
            final tokens = theme.extension<AppTokens>()!;

            final code = _codeText(tester);
            expect(code.textSpan!.toPlainText(), allCategoriesSource);
            final keyword = runOf(code, 'final');
            expect(keyword.style?.color, tokens.syntaxKeyword);
            expect(keyword.style?.fontWeight, FontWeight.w600);
            expect(runOf(code, '"s"').style?.color, tokens.syntaxString);
            expect(runOf(code, '42').style?.color, tokens.syntaxNumber);
            final comment = runOf(code, '// exact');
            expect(comment.style?.color, tokens.syntaxComment);
            expect(comment.style?.fontStyle, FontStyle.italic);
            final literal = runOf(code, 'true');
            expect(literal.style?.color, tokens.syntaxLiteral);
            // The two defects this batch removes: literals are not failure
            // signals, and status/tool colors are not syntax colors.
            expect(literal.style?.color, isNot(tokens.statusError));
            expect(
              runOf(code, '"s"').style?.color,
              isNot(tokens.statusWorking),
            );
            expect(
              runOf(code, '42').style?.color,
              isNot(tokens.statusNeedsInput),
            );
            expect(find.byType(SelectableText), findsNothing);
            expect(tester.takeException(), isNull);
          },
        );
      }
    }

    testWidgets('code sits on a surface2 plane with 12dp padding and 1.5 line '
        'height under a slim labeled header', (tester) async {
      final theme = await _pumpMarkdown(tester, allCategoriesFence);
      final tokens = theme.extension<AppTokens>()!;

      final container = tester.widget<Container>(
        find.byKey(const ValueKey('markdown-code-block-0')),
      );
      final decoration = container.decoration! as BoxDecoration;
      expect(decoration.color, tokens.surface2);

      final padding = tester.widget<Padding>(
        find
            .ancestor(
              of: find.byKey(const ValueKey('markdown-code-block-0-code')),
              matching: find.byType(Padding),
            )
            .first,
      );
      expect(padding.padding, const EdgeInsets.all(12));
      expect(_codeText(tester).textSpan!.style?.height, 1.5);

      final label = tester.widget<Text>(
        find.byKey(const ValueKey('markdown-code-block-0-language')),
      );
      expect(label.data, 'dart');
      // The header is chrome: it must stay outside the transcript selection.
      expect(
        find.ancestor(
          of: find.byKey(const ValueKey('markdown-code-block-0-language')),
          matching: find.byType(SelectionContainer),
        ),
        findsWidgets,
      );
    });

    testWidgets('header copy returns the exact authored source', (
      tester,
    ) async {
      String? clipboardText;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            clipboardText =
                (call.arguments as Map<Object?, Object?>)['text'] as String?;
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );

      await _pumpMarkdown(tester, allCategoriesFence);
      await tester.tap(
        find.byKey(const ValueKey('markdown-code-block-0-copy')),
      );
      await tester.pumpAndSettle();

      expect(clipboardText, allCategoriesSource);
      expect(find.text('Code copied'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('unknown languages preserve exact text as one literal run', (
      tester,
    ) async {
      const source = 'alpha < beta && punctuation::stays';
      await _pumpMarkdown(tester, '```unknown-v9\n$source\n```');

      final root = _codeText(tester).textSpan! as TextSpan;
      expect(root.toPlainText(), source);
      expect(root.children, hasLength(1));
      expect(
        (root.children!.single as TextSpan).style?.fontFamily,
        'monospace',
      );
      // The fallback still shows the authored label and the copy affordance.
      expect(
        tester
            .widget<Text>(
              find.byKey(const ValueKey('markdown-code-block-0-language')),
            )
            .data,
        'unknown-v9',
      );
      expect(
        find.byKey(const ValueKey('markdown-code-block-0-copy')),
        findsOneWidget,
      );
    });

    testWidgets('over-128K UTF-16 code-unit blocks stay bounded and exact', (
      tester,
    ) async {
      final source = List<String>.filled(
        maxHighlightedTranscriptCodeUnits + 1,
        'x',
      ).join();
      await _pumpMarkdown(
        tester,
        '```dart\n$source\n```',
        viewSize: const Size(320, 480),
      );

      final root = _codeText(tester).textSpan! as TextSpan;
      expect(root.toPlainText(), source);
      expect(root.children, hasLength(1));
      expect(tester.takeException(), isNull);
    });

    testWidgets('unterminated fences preserve source and selection semantics', (
      tester,
    ) async {
      const source = 'void main() {\n  final value = "unterminated';
      await _pumpMarkdown(tester, '```dart\n$source');

      expect(_codeText(tester).textSpan!.toPlainText(), source);
      expect(find.byType(SelectableText), findsNothing);
      expect(tester.takeException(), isNull);
    });
  });

  group('transcript markdown heading scale (U2)', () {
    const headingsBesideBody =
        '# Alpha\n\n## Beta\n\n### Gamma\n\nBody paragraph.';

    testWidgets(
      'H1 is capped at titleSmall and H2/H3 never exceed it',
      (tester) async {
        final theme = await _pumpMarkdown(tester, headingsBesideBody);
        final cap = theme.textTheme.titleSmall!.fontSize!;

        final h1 = _rootStyle(tester, 'Alpha');
        final h2 = _rootStyle(tester, 'Beta');
        final h3 = _rootStyle(tester, 'Gamma');
        final body = _rootStyle(tester, 'Body paragraph.');

        // The old titleLarge/titleMedium mapping violates every one of these
        // relational caps, so restoring it fails this test.
        expect(h1.fontSize, lessThanOrEqualTo(cap));
        expect(h2.fontSize, lessThanOrEqualTo(cap));
        expect(h2.fontSize, lessThanOrEqualTo(h1.fontSize!));
        expect(h3.fontSize, lessThanOrEqualTo(h1.fontSize!));
        expect(body.fontSize, theme.textTheme.bodyMedium!.fontSize);
      },
    );

    testWidgets('hierarchy is carried by weight, not a font-size jump', (
      tester,
    ) async {
      await _pumpMarkdown(tester, headingsBesideBody);

      final h1 = _rootStyle(tester, 'Alpha');
      final h2 = _rootStyle(tester, 'Beta');
      final h3 = _rootStyle(tester, 'Gamma');
      final body = _rootStyle(tester, 'Body paragraph.');

      // Strict H1 > H2 > H3 > body weight progression at body size.
      expect(h1.fontWeight, FontWeight.w700);
      expect(h2.fontWeight, FontWeight.w600);
      expect(h3.fontWeight, FontWeight.w500);
      final bodyWeight = body.fontWeight?.value ?? FontWeight.normal.value;
      expect(h1.fontWeight!.value, greaterThan(h2.fontWeight!.value));
      expect(h2.fontWeight!.value, greaterThan(h3.fontWeight!.value));
      expect(h3.fontWeight!.value, greaterThan(bodyWeight));
    });

    testWidgets(
      'heading markers are hidden and block order is preserved',
      (tester) async {
        await _pumpMarkdown(
          tester,
          '# Goals\n\nDo the thing.\n\n- first\n- second',
        );

        expect(find.textContaining('# Goals'), findsNothing);
        expect(find.textContaining('- first'), findsNothing);
        expect(find.textContaining('Goals'), findsOneWidget);
        // Bodies stay plain Text so the ancestor SelectionArea keeps working.
        expect(find.byType(SelectableText), findsNothing);

        final goals = tester.getTopLeft(find.textContaining('Goals'));
        final paragraph = tester.getTopLeft(
          find.textContaining('Do the thing.'),
        );
        final first = tester.getTopLeft(find.textContaining('first'));
        final second = tester.getTopLeft(find.textContaining('second'));
        expect(goals.dy, lessThan(paragraph.dy));
        expect(paragraph.dy, lessThan(first.dy));
        expect(first.dy, lessThan(second.dy));
      },
    );

    testWidgets('long headings wrap within a Compact width', (tester) async {
      const longHeading =
          '# A very long plan heading that must wrap onto at least '
          'two lines instead of overflowing the compact transcript width';
      await _pumpMarkdown(
        tester,
        '# Short\n\n$longHeading',
        viewSize: const Size(360, 800),
      );

      final shortFinder = find.textContaining('Short');
      final longFinder = find.textContaining('very long plan heading');
      expect(shortFinder, findsOneWidget);
      expect(longFinder, findsOneWidget);
      expect(tester.takeException(), isNull);
      expect(tester.getSize(longFinder).width, lessThanOrEqualTo(360));
      expect(
        tester.getSize(longFinder).height,
        greaterThan(tester.getSize(shortFinder).height),
      );
    });

    testWidgets('long Chinese headings wrap within a Compact width', (
      tester,
    ) async {
      final longHeading = '### ${'这是一个很长的计划标题' * 8}';
      await _pumpMarkdown(
        tester,
        '## 短标题\n\n$longHeading',
        viewSize: const Size(360, 800),
      );

      final shortFinder = find.textContaining('短标题');
      final longFinder = find.textContaining('这是一个很长的计划标题');
      expect(shortFinder, findsOneWidget);
      expect(longFinder, findsOneWidget);
      expect(tester.takeException(), isNull);
      expect(tester.getSize(longFinder).width, lessThanOrEqualTo(360));
      expect(
        tester.getSize(longFinder).height,
        greaterThan(tester.getSize(shortFinder).height),
      );
    });

    testWidgets('large text scale renders headings without clipping', (
      tester,
    ) async {
      await _pumpMarkdown(
        tester,
        headingsBesideBody,
        viewSize: const Size(360, 800),
      );
      final normalHeight = tester.getSize(find.textContaining('Alpha')).height;

      await _pumpMarkdown(
        tester,
        headingsBesideBody,
        viewSize: const Size(360, 800),
        textScaler: const TextScaler.linear(2),
      );
      final scaledFinder = find.textContaining('Alpha');
      final scaledHeight = tester.getSize(scaledFinder).height;

      // The scale override must actually reach the rendered heading: a 2x
      // scaler yields a taller line than 1x, so a detached MediaQuery fails.
      expect(scaledHeight, greaterThan(normalHeight));
      expect(find.textContaining('Gamma'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    for (final brightness in Brightness.values) {
      testWidgets('heading caps hold in ${brightness.name} mode', (
        tester,
      ) async {
        final theme = await _pumpMarkdown(
          tester,
          headingsBesideBody,
          brightness: brightness,
        );
        final cap = theme.textTheme.titleSmall!.fontSize!;

        expect(
          _rootStyle(tester, 'Alpha').fontSize,
          lessThanOrEqualTo(cap),
        );
        expect(
          _rootStyle(tester, 'Gamma').fontSize,
          lessThanOrEqualTo(cap),
        );
        expect(tester.takeException(), isNull);
      });
    }

    for (final density in UiDensity.values) {
      testWidgets('headings render cleanly at ${density.name} density', (
        tester,
      ) async {
        await _pumpMarkdown(
          tester,
          '# Alpha\n\nBody paragraph.\n\n- one\n- two',
          density: density,
        );

        expect(find.textContaining('Alpha'), findsOneWidget);
        expect(find.textContaining('two'), findsOneWidget);
        expect(tester.takeException(), isNull);
      });
    }
  });
}

/// Pumps a markdown model-output body under the app theme and returns the
/// resolved in-tree theme so tests can relate rendered styles to the
/// semantic text roles (a bare [ThemeData] leaves role sizes unresolved).
Future<ThemeData> _pumpMarkdown(
  WidgetTester tester,
  String markdown, {
  Brightness brightness = Brightness.light,
  UiDensity density = UiDensity.comfortable,
  TextScaler textScaler = TextScaler.noScaling,
  Size viewSize = const Size(800, 600),
}) async {
  tester.view
    ..physicalSize = viewSize
    ..devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  final spec = themeSpecById(kDefaultThemeId);
  final theme = buildAppTheme(
    brightness == Brightness.dark ? spec.dark : spec.light,
    brightness,
    density: density.visualDensity,
  );
  late ThemeData resolvedTheme;
  await tester.pumpWidget(
    MediaQuery(
      data: MediaQueryData(textScaler: textScaler),
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: theme,
        home: Scaffold(
          body: SingleChildScrollView(
            child: Builder(
              builder: (context) {
                resolvedTheme = Theme.of(context);
                return buildAgentMessageRenderer(
                  context,
                  AgentMessage.fromJson({
                    'type': 'model-output',
                    'text': markdown,
                  }),
                );
              },
            ),
          ),
        ),
      ),
    ),
  );
  return resolvedTheme;
}

/// Returns the root span style of the rich [Text] that contains [text].
///
/// Heading and paragraph runs inherit the root span's size and weight, so the
/// root style carries the rendered typography for plain-text content.
TextStyle _rootStyle(WidgetTester tester, String text) {
  final finder = find.textContaining(text);
  expect(finder, findsOneWidget);
  return tester.widget<Text>(finder).textSpan!.style!;
}

Text _codeText(WidgetTester tester) => tester.widget<Text>(
  find.byKey(const ValueKey('markdown-code-block-0-code')),
);
