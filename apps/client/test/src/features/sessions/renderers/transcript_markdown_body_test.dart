import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/design/ui_scale.dart';
// The canonical feature imports below exceed the style line width; keep the
// stable package paths for boundary-safe package import resolution.
// ignore: lines_longer_than_80_chars
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
// The line-width exception above applies to each canonical path that follows.
// ignore: lines_longer_than_80_chars
import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
// The line-width exception above applies to each canonical path that follows.
// ignore: lines_longer_than_80_chars
import 'package:cosyncing_client/src/features/sessions/transcript/file_reference.dart';
// The line-width exception above applies to each canonical path that follows.
// ignore: lines_longer_than_80_chars
import 'package:cosyncing_client/src/features/sessions/transcript/session_file_link_scope.dart';
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

    testWidgets('a bare path in prose is never a file link, gate open or not', (
      tester,
    ) async {
      // The v1 rule: only a path with PROVENANCE — one that arrived in a
      // structured contract field — becomes a link. `src/main.rs` in a sentence
      // may be a file the agent read, one it plans to create, one in another
      // repo, or a quotation; resolving all four the same way produces dead
      // links. This guards that decision against accidental regression.
      final opened = <SessionFileReference>[];
      await tester.pumpWidget(
        MaterialApp(
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: Scaffold(
            body: SessionFileLinkScope(
              sessionKey: const SessionDetailKey(
                tool: 'claude',
                sessionId: 'session-1',
              ),
              gate: SessionFileLinkGate.open,
              onOpen: opened.add,
              onProbeNeeded: () {},
              child: Builder(
                builder: (context) => buildAgentMessageRenderer(
                  context,
                  AgentMessage.fromJson({
                    'type': 'model-output',
                    'text': 'I updated src/main.rs:42 and lib/other.dart.',
                  }),
                ),
              ),
            ),
          ),
        ),
      );

      final prose = find.textContaining('src/main.rs:42');
      expect(prose, findsOneWidget);
      expect(
        _runStyle(
          tester,
          prose,
          'I updated src/main.rs:42 and lib/other.dart.',
        )?.decoration,
        isNot(TextDecoration.underline),
      );
      await tester.tap(prose);
      await tester.pump();
      expect(opened, isEmpty);
    });
  });

  testWidgets(
    'report links and table filenames resolve in their session',
    (tester) async {
      final opened = <SessionFileReference>[];
      await tester.pumpWidget(
        MaterialApp(
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: Scaffold(
            body: SessionFileLinkScope(
              sessionKey: const SessionDetailKey(
                tool: 'pi',
                sessionId: 'report-session',
              ),
              gate: SessionFileLinkGate.open,
              onOpen: (_) => fail('report mentions should use resolution'),
              onFind: opened.add,
              onProbeNeeded: () {},
              child: Builder(
                builder: (context) => buildAgentMessageRenderer(
                  context,
                  AgentMessage.fromJson({
                    'type': 'model-output',
                    'text':
                        '[source](src/main.py:12)\n\n| File |\n|---|\n| `PLAN.md` |',
                  }),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.tap(
        find.byKey(
          const ValueKey('transcript-file-mention-source (src/main.py:12)'),
        ),
      );
      expect(opened.single.rawPath, 'src/main.py');
      expect(opened.single.line, 12);
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.tap(
        find.byKey(const ValueKey('transcript-file-mention-PLAN.md')),
      );
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      expect(opened.last.rawPath, 'PLAN.md');
    },
  );

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

    testWidgets('code header goldens cover EN/ZH and both brightnesses', (
      tester,
    ) async {
      for (final variant in const [
        (
          locale: Locale('en'),
          brightness: Brightness.light,
          file: 'goldens/code_header_light_en.png',
        ),
        (
          locale: Locale('zh'),
          brightness: Brightness.light,
          file: 'goldens/code_header_light_zh.png',
        ),
        (
          locale: Locale('en'),
          brightness: Brightness.dark,
          file: 'goldens/code_header_dark_en.png',
        ),
        (
          locale: Locale('zh'),
          brightness: Brightness.dark,
          file: 'goldens/code_header_dark_zh.png',
        ),
      ]) {
        await _pumpMarkdown(
          tester,
          allCategoriesFence,
          locale: variant.locale,
          brightness: variant.brightness,
        );
        await expectLater(
          find.byKey(const ValueKey('markdown-code-block-0')),
          matchesGoldenFile(variant.file),
        );
      }
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
  TargetPlatform platform = TargetPlatform.linux,
  Locale locale = const Locale('en'),
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
  ).copyWith(platform: platform);
  late ThemeData resolvedTheme;
  await tester.pumpWidget(
    MediaQuery(
      data: MediaQueryData(textScaler: textScaler),
      child: MaterialApp(
        locale: locale,
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
