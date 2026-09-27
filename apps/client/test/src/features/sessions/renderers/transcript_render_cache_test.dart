import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/transcript_markdown.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/transcript_render_cache.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

ThemeData _appTheme(Brightness brightness) {
  final spec = themeSpecById(kDefaultThemeId);
  return buildAppTheme(
    brightness == Brightness.dark ? spec.dark : spec.light,
    brightness,
  );
}

String _text(int units, String tag) =>
    tag + List.filled(units - tag.length, 'x').join();

/// Hosts one markdown body whose text and theme the test changes.
final class _Host extends StatefulWidget {
  const _Host({required this.source, required this.theme});

  /// The text, and a count that changes to rebuild with the same text.
  final ValueNotifier<(String, int)> source;
  final ValueNotifier<ThemeData> theme;

  @override
  State<_Host> createState() => _HostState();
}

class _HostState extends State<_Host> {
  @override
  Widget build(BuildContext context) => ValueListenableBuilder<ThemeData>(
    valueListenable: widget.theme,
    builder: (context, theme, _) => MaterialApp(
      theme: theme,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      home: Scaffold(
        body: SingleChildScrollView(
          child: ValueListenableBuilder<(String, int)>(
            valueListenable: widget.source,
            // A new body widget every rebuild, as a parent rebuilding its
            // rows would produce.
            builder: (context, source, _) =>
                buildTranscriptMarkdownBody(source.$1),
          ),
        ),
      ),
    ),
  );
}

RenderParagraph _paragraph(WidgetTester tester, String text) =>
    tester.renderObject<RenderParagraph>(
      find.byWidgetPredicate(
        (widget) =>
            widget is RichText && widget.text.toPlainText().contains(text),
      ),
    );

void main() {
  group('the cache', () {
    test('answers the same text from what it parsed', () {
      final cache = TranscriptRenderCache();
      final first = cache.markdown('# Title\n\nBody text.');
      final second = cache.markdown('# Title\n\nBody text.');
      expect(first.hit, isFalse);
      expect(second.hit, isTrue);
      expect(identical(first.blocks, second.blocks), isTrue);
      expect(cache.markdownEntries, 1);
      expect(
        cache.markdownUnits,
        '# Title\n\nBody text.'.length + TranscriptRenderCache.entryUnits,
      );
    });

    test('keeps nothing it was told not to', () {
      final cache = TranscriptRenderCache()
        ..markdown('streaming, part one', keep: false);
      expect(cache.markdownEntries, 0);
      expect(cache.markdown('streaming, part one').hit, isFalse);
    });

    test('is bounded by the text it holds, least recently used first out', () {
      // Eight entries of twelve code units each fit; a ninth does not.
      const entry = 12 + TranscriptRenderCache.entryUnits;
      const budget = entry * 8 + entry ~/ 2;
      final cache = TranscriptRenderCache(markdownBudget: budget);
      for (final tag in ['a', 'b', 'c', 'd', 'e']) {
        cache.markdown(_text(12, tag));
      }
      expect(cache.markdownUnits, entry * 5);
      // Reading `a` makes it the most recently used.
      expect(cache.markdown(_text(12, 'a')).hit, isTrue);
      for (final tag in ['f', 'g', 'h']) {
        cache.markdown(_text(12, tag));
      }
      expect(cache.markdownUnits, lessThanOrEqualTo(budget));
      expect(cache.markdownEntries, 8);
      cache.markdown(_text(12, 'i'));
      expect(cache.markdownEntries, 8);
      expect(cache.markdown(_text(12, 'a')).hit, isTrue, reason: 'recent');
      expect(cache.markdown(_text(12, 'b')).hit, isFalse, reason: 'oldest');
    });

    test('does not keep a text too large to be worth it', () {
      final cache =
          TranscriptRenderCache(
              markdownBudget: (100 + TranscriptRenderCache.entryUnits) * 8,
            )
            ..markdown(_text(99, 'small'))
            ..markdown(_text(100, 'large'));
      expect(cache.markdownEntries, 1);
      expect(cache.markdown(_text(100, 'large')).hit, isFalse);
    });

    test('keeps highlighted code by language and text', () {
      final cache = TranscriptRenderCache();
      const source = 'final value = 42;';
      expect(cache.code(source, language: 'dart').hit, isFalse);
      expect(cache.code(source, language: 'dart').hit, isTrue);
      expect(cache.code(source, language: 'ts').hit, isFalse);
      final tokens = cache.code(source, language: 'dart').tokens;
      expect(
        tokens.map((token) => token.text).join(),
        source,
        reason: 'highlighting never changes a byte',
      );
      expect(
        tokens.map((token) => token.kind),
        contains(TranscriptCodeTokenKind.keyword),
      );
      cache.code('streaming code', language: 'dart', keep: false);
      expect(cache.codeEntries, 2);
    });

    test('keeps no empty code, whatever its language label', () {
      final cache = TranscriptRenderCache(codeBudget: 1024);
      for (var index = 0; index < 10000; index++) {
        final result = cache.code('', language: 'unknown-language-$index');
        expect(result.tokens.map((token) => token.text).join(), isEmpty);
      }
      expect(cache.codeEntries, 0);
      expect(cache.codeUnits, 0);
      expect(cache.code('', language: 'unknown-language-0').hit, isFalse);
    });

    test('keeps no empty markdown', () {
      final cache = TranscriptRenderCache()..markdown('');
      expect(cache.markdownEntries, 0);
      expect(cache.markdownUnits, 0);
    });

    test('counts the language label a code entry keeps', () {
      final cache = TranscriptRenderCache();
      final label = 'l' * 300;
      cache.code('x', language: label);
      expect(cache.codeEntries, 1);
      expect(
        cache.codeUnits,
        label.length + 1 + TranscriptRenderCache.entryUnits,
      );
      // A label that alone is an eighth of the budget is not worth keeping.
      final small = TranscriptRenderCache(codeBudget: 4096)
        ..code('x', language: 'l' * 512);
      expect(small.codeEntries, 0);
      expect(small.codeUnits, 0);
    });

    test('bounds how many small entries it keeps, and never reports more '
        'than its budget', () {
      const budget = 4096;
      final cache = TranscriptRenderCache(
        markdownBudget: budget,
        codeBudget: budget,
      );
      const most = budget ~/ TranscriptRenderCache.entryUnits;
      for (var index = 0; index < 10000; index++) {
        cache
          ..markdown('$index')
          ..code('$index', language: 'l$index');
        expect(cache.markdownUnits, lessThanOrEqualTo(budget));
        expect(cache.codeUnits, lessThanOrEqualTo(budget));
        expect(cache.markdownEntries, lessThanOrEqualTo(most));
        expect(cache.codeEntries, lessThanOrEqualTo(most));
      }
      expect(cache.markdownEntries, greaterThan(0));
      expect(cache.codeEntries, greaterThan(0));
      // The newest are the ones kept.
      expect(cache.markdown('9999').hit, isTrue);
      expect(cache.code('9999', language: 'l9999').hit, isTrue);
      expect(cache.markdown('0').hit, isFalse);
    });
  });

  group('block identity', () {
    MarkdownBlock one(String source) => parseTranscriptMarkdown(source).single;

    test('the same text parses to the same block, of every kind', () {
      for (final source in [
        'A paragraph with **bold** and a [link](https://example.com).',
        '## A heading',
        '- one\n- two',
        '3. three\n4. four',
        '```dart\nfinal x = 1;\n```',
        '> quoted',
        '---',
        '| a | b |\n| --- | :-: |\n| 1 | 2 |',
      ]) {
        expect(
          sameTranscriptMarkdownBlock(one(source), one(source)),
          isTrue,
          reason: source,
        );
      }
    });

    test('any difference that renders differently is a different block', () {
      for (final (left, right) in [
        ('A [link](https://a.example).', 'A [link](https://b.example).'),
        ('Some **bold**.', 'Some *bold*.'),
        ('## A heading', '### A heading'),
        ('- one\n- two', '- one\n- too'),
        ('3. three', '4. three'),
        ('```dart\nfinal x = 1;\n```', '```ts\nfinal x = 1;\n```'),
        ('```dart\nfinal x = 1;\n```', '```dart\nfinal x = 2;\n```'),
        ('> quoted', '> quote'),
        (
          '| a | b |\n| --- | --- |\n| 1 | 2 |',
          '| a | b |\n| --- | --: |\n| 1 | 2 |',
        ),
        (
          '| a | b |\n| --- | --- |\n| 1 | 2 |',
          '| a | b |\n| --- | --- |\n| 1 | 3 |',
        ),
        ('A paragraph', '## A paragraph'),
      ]) {
        expect(
          sameTranscriptMarkdownBlock(one(left), one(right)),
          isFalse,
          reason: '$left / $right',
        );
      }
      // A fence still streaming in is not the finished block.
      final open = parseTranscriptMarkdown('```dart\nfinal x = 1;').single;
      final closed = one('```dart\nfinal x = 1;\n```');
      expect(sameTranscriptMarkdownBlock(open, closed), isFalse);
    });
  });

  group('a markdown body', () {
    late ValueNotifier<(String, int)> source;
    late ValueNotifier<ThemeData> theme;
    void setText(String text) => source.value = (text, source.value.$2 + 1);

    setUp(() {
      source = ValueNotifier((
        'First paragraph, with a [link](https://a.example).',
        0,
      ));
      theme = ValueNotifier(_appTheme(Brightness.light));
      transcriptRenderCache.clear();
      debugTranscriptRenderWork = TranscriptRenderWorkCounter();
    });
    tearDown(() => debugTranscriptRenderWork = null);

    testWidgets('rebuilt with the same text keeps everything it built', (
      tester,
    ) async {
      await tester.pumpWidget(_Host(source: source, theme: theme));
      final before = _paragraph(tester, 'First paragraph');
      final span = before.text;
      // The same text, as a new string: a parent rebuilding its rows.
      setText(
        'First paragraph, with a [link](https://a.example). '.trimRight(),
      );
      await tester.pump();
      final work = debugTranscriptRenderWork!;
      expect(work.markdownBodyReuses, 1);
      expect(work.markdownParses, 1, reason: 'parsed once, when first built');
      final after = _paragraph(tester, 'First paragraph');
      expect(identical(before, after), isTrue);
      expect(identical(span, after.text), isTrue, reason: 'nothing to lay out');
    });

    testWidgets('growing keeps the blocks before the first that changed', (
      tester,
    ) async {
      setText(
        'First paragraph.\n\n```dart\nfinal x = 1;\n```\n\nThird, growing',
      );
      await tester.pumpWidget(_Host(source: source, theme: theme));
      final first = _paragraph(tester, 'First paragraph').text;
      final code = _paragraph(tester, 'final x').text;
      final growing = _paragraph(tester, 'Third, growing').text;

      setText(
        '${source.value.$1} and grown.\n\nA fourth paragraph.\n\n'
        '```dart\nfinal y = 2;\n```',
      );
      await tester.pump();
      expect(debugTranscriptRenderWork!.markdownBlocksReused, 2);
      expect(
        identical(first, _paragraph(tester, 'First paragraph').text),
        isTrue,
      );
      expect(identical(code, _paragraph(tester, 'final x').text), isTrue);
      expect(
        identical(growing, _paragraph(tester, 'Third, growing').text),
        isFalse,
      );
      expect(find.textContaining('and grown.'), findsOneWidget);
      expect(find.textContaining('A fourth paragraph.'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('markdown-code-block-0-code')),
        findsOneWidget,
        reason: 'the kept code block keeps its number',
      );
      expect(
        find.byKey(const ValueKey('markdown-code-block-1-code')),
        findsOneWidget,
        reason: 'and a new one is numbered after it',
      );
    });

    testWidgets('a changed theme rebuilds with the new theme', (tester) async {
      await tester.pumpWidget(_Host(source: source, theme: theme));
      // The body's own style, inside the one the text widget adds around it
      // from the ambient text style.
      Color? bodyColor() {
        final outer = _paragraph(tester, 'First paragraph').text as TextSpan;
        return outer.children!.first.style?.color;
      }

      final light = bodyColor();
      theme.value = _appTheme(Brightness.dark);
      await tester.pumpAndSettle();
      final dark = bodyColor();
      expect(dark, isNot(light));
      expect(
        dark,
        Theme.of(
          tester.element(find.byType(Scaffold)),
        ).textTheme.bodyMedium?.color,
      );
    });

    testWidgets('each style the body uses, changed alone, rebuilds it', (
      tester,
    ) async {
      setText(
        '# A heading\n\nFirst paragraph, with a [link](https://a.example).',
      );
      await tester.pumpWidget(_Host(source: source, theme: theme));
      TextStyle? style(String text) {
        final outer = _paragraph(tester, text).text as TextSpan;
        return outer.children!.first.style;
      }

      final base = theme.value;
      final body = base.copyWith(
        textTheme: base.textTheme.copyWith(
          bodyMedium: base.textTheme.bodyMedium!.copyWith(fontSize: 21),
        ),
      );
      theme.value = body;
      await tester.pumpAndSettle();
      expect(style('First paragraph')?.fontSize, 21);

      final title = body.copyWith(
        textTheme: body.textTheme.copyWith(
          titleSmall: body.textTheme.titleSmall!.copyWith(fontSize: 23),
        ),
      );
      theme.value = title;
      await tester.pumpAndSettle();
      expect(style('A heading')?.fontSize, 23);

      const red = Color(0xFFD50000);
      theme.value = title.copyWith(
        colorScheme: title.colorScheme.copyWith(primary: red),
      );
      await tester.pumpAndSettle();
      expect(tester.widget<Text>(find.text('link')).style?.color, red);
    });

    testWidgets('a text still changing is not kept in the cache', (
      tester,
    ) async {
      await tester.pumpWidget(_Host(source: source, theme: theme));
      expect(transcriptRenderCache.markdownEntries, 1);
      for (var chunk = 0; chunk < 5; chunk++) {
        setText('${source.value.$1} more $chunk');
        await tester.pump();
      }
      expect(transcriptRenderCache.markdownEntries, 1);
    });
  });
}
