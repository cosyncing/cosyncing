import 'package:cosyncing_client/src/features/sessions/renderers/transcript_markdown.dart';
import 'package:flutter_test/flutter_test.dart';

/// Flattens inline runs to their concatenated literal text.
String _plain(List<MarkdownInline> spans) =>
    spans.map((span) => span.text).join();

void main() {
  group('highlightTranscriptCode', () {
    test('classifies common Dart tokens without changing text', () {
      const source = 'final count = 42; // retained exactly';
      final spans = highlightTranscriptCode(source, language: 'dart');

      expect(spans.map((span) => span.text).join(), source);
      expect(
        spans.any(
          (span) =>
              span.kind == TranscriptCodeTokenKind.keyword &&
              span.text == 'final',
        ),
        isTrue,
      );
      expect(
        spans.any(
          (span) =>
              span.kind == TranscriptCodeTokenKind.number && span.text == '42',
        ),
        isTrue,
      );
      expect(
        spans.any(
          (span) =>
              span.kind == TranscriptCodeTokenKind.comment &&
              span.text == '// retained exactly',
        ),
        isTrue,
      );
    });

    test('unknown languages and oversized blocks stay one literal run', () {
      const unknown = 'alpha < beta && gamma';
      expect(
        highlightTranscriptCode(unknown, language: 'future-lang'),
        [
          const TranscriptCodeToken(
            unknown,
            kind: TranscriptCodeTokenKind.plain,
          ),
        ],
      );

      final oversized = 'x' * (maxHighlightedTranscriptCodeUnits + 1);
      final spans = highlightTranscriptCode(oversized, language: 'dart');
      expect(spans, hasLength(1));
      expect(spans.single.text, oversized);
      expect(spans.single.kind, TranscriptCodeTokenKind.plain);
    });

    test('large known-language input stays exact with bounded styled runs', () {
      final source = 'final value = 42; // note\n' * 3000;
      expect(source.length, lessThan(maxHighlightedTranscriptCodeUnits));

      final spans = highlightTranscriptCode(source, language: 'dart');

      expect(spans.map((span) => span.text).join(), source);
      expect(spans.length, lessThanOrEqualTo(4096));
    });

    test(
      'aliases are case-insensitive and malformed fence bodies stay exact',
      () {
        const source = 'const value = "unterminated';
        final spans = highlightTranscriptCode(source, language: 'DART');

        expect(spans.map((span) => span.text).join(), source);
        expect(spans.first.kind, TranscriptCodeTokenKind.keyword);
      },
    );
  });

  group('parseTranscriptMarkdown blocks', () {
    test('returns no blocks for empty and whitespace-only input', () {
      expect(parseTranscriptMarkdown(null), isEmpty);
      expect(parseTranscriptMarkdown(''), isEmpty);
      expect(parseTranscriptMarkdown('   \n\n  \t '), isEmpty);
    });

    test('passes plain text through unchanged', () {
      const source = 'Just a normal sentence with no markdown at all.';
      final blocks = parseTranscriptMarkdown(source);

      expect(blocks, hasLength(1));
      final paragraph = blocks.single as MarkdownParagraph;
      expect(paragraph.spans, hasLength(1));
      expect(paragraph.spans.single.text, source);
      expect(paragraph.spans.single.bold, isFalse);
      expect(paragraph.spans.single.italic, isFalse);
      expect(paragraph.spans.single.code, isFalse);
      expect(transcriptMarkdownLooksPlain(source), isTrue);
    });

    test('keeps characters that only look like markdown as literal text', () {
      const source = 'Use 2 * 3 * 4 and a_variable_name in C++.';
      final blocks = parseTranscriptMarkdown(source);
      final paragraph = blocks.single as MarkdownParagraph;

      expect(_plain(paragraph.spans), source);
      expect(paragraph.spans.every((span) => !span.italic), isTrue);
    });

    test('parses headings at every level', () {
      final blocks = parseTranscriptMarkdown(
        '# One\n## Two\n### Three\n#### Four\n##### Five\n###### Six',
      );

      expect(blocks, hasLength(6));
      for (var level = 1; level <= 6; level++) {
        final heading = blocks[level - 1] as MarkdownHeading;
        expect(heading.level, level);
      }
      expect(_plain((blocks.first as MarkdownHeading).spans), 'One');
    });

    test('does not treat a hash without a space as a heading', () {
      final blocks = parseTranscriptMarkdown('#hashtag not a heading');
      expect(blocks.single, isA<MarkdownParagraph>());
    });

    test('parses bullet lists with all markers', () {
      final blocks = parseTranscriptMarkdown('- one\n* two\n+ three');
      final list = blocks.single as MarkdownBulletList;

      expect(list.items, hasLength(3));
      expect(_plain(list.items[0]), 'one');
      expect(_plain(list.items[2]), 'three');
    });

    test('parses ordered lists and records the starting ordinal', () {
      final blocks = parseTranscriptMarkdown('3. three\n4. four\n5) five');
      final list = blocks.single as MarkdownOrderedList;

      expect(list.start, 3);
      expect(list.items, hasLength(3));
      expect(_plain(list.items[2]), 'five');
    });

    test('parses blockquotes and joins their lines', () {
      final blocks = parseTranscriptMarkdown('> quoted line\n> second line');
      final quote = blocks.single as MarkdownBlockquote;

      expect(_plain(quote.spans), 'quoted line\nsecond line');
    });

    test('parses thematic breaks', () {
      final blocks = parseTranscriptMarkdown('above\n\n---\n\nbelow');

      expect(blocks, hasLength(3));
      expect(blocks[1], isA<MarkdownThematicBreak>());
    });

    test('parses a closed fenced code block with a language', () {
      final blocks = parseTranscriptMarkdown(
        'intro\n\n```bash\necho hi\nls -la\n```\n\noutro',
      );

      expect(blocks, hasLength(3));
      final code = blocks[1] as MarkdownCodeBlock;
      expect(code.language, 'bash');
      expect(code.code, 'echo hi\nls -la');
      expect(code.closed, isTrue);
    });

    test('recovers an unterminated fence as a code block', () {
      final blocks = parseTranscriptMarkdown('```dart\nvoid main() {');

      final code = blocks.single as MarkdownCodeBlock;
      expect(code.language, 'dart');
      expect(code.code, 'void main() {');
      expect(code.closed, isFalse);
    });

    test('keeps markdown syntax inside a fence literal', () {
      final blocks = parseTranscriptMarkdown(
        '```\n# not a heading\n- not a list\n**not bold**\n```',
      );

      final code = blocks.single as MarkdownCodeBlock;
      expect(code.code, '# not a heading\n- not a list\n**not bold**');
    });

    test('handles a bare fence with no language and empty body', () {
      final blocks = parseTranscriptMarkdown('```\n```');
      final code = blocks.single as MarkdownCodeBlock;

      expect(code.language, isEmpty);
      expect(code.code, isEmpty);
      expect(code.closed, isTrue);
    });

    test('supports tilde fences', () {
      final blocks = parseTranscriptMarkdown('~~~\nplain\n~~~');
      final code = blocks.single as MarkdownCodeBlock;

      expect(code.code, 'plain');
      expect(code.closed, isTrue);
    });

    test('normalizes CRLF line endings', () {
      final blocks = parseTranscriptMarkdown('# Title\r\n\r\nBody text');

      expect(blocks, hasLength(2));
      expect(_plain((blocks.first as MarkdownHeading).spans), 'Title');
      expect(_plain((blocks[1] as MarkdownParagraph).spans), 'Body text');
    });

    test('separates a paragraph from a following list', () {
      final blocks = parseTranscriptMarkdown(
        'Intro line\n- item one\n- item two',
      );

      expect(blocks, hasLength(2));
      expect(blocks[0], isA<MarkdownParagraph>());
      expect((blocks[1] as MarkdownBulletList).items, hasLength(2));
    });
  });

  group('parseTranscriptMarkdownInline', () {
    test('returns no runs for empty input', () {
      expect(parseTranscriptMarkdownInline(null), isEmpty);
      expect(parseTranscriptMarkdownInline(''), isEmpty);
    });

    test('parses bold with both markers', () {
      for (final source in ['**bold**', '__bold__']) {
        final spans = parseTranscriptMarkdownInline(source);
        expect(spans.single.text, 'bold', reason: source);
        expect(spans.single.bold, isTrue, reason: source);
      }
    });

    test('parses italic with both markers', () {
      for (final source in ['*it*', '_it_']) {
        final spans = parseTranscriptMarkdownInline(source);
        expect(spans.single.text, 'it', reason: source);
        expect(spans.single.italic, isTrue, reason: source);
      }
    });

    test('parses nested emphasis into a combined run', () {
      final spans = parseTranscriptMarkdownInline('**bold *and italic* rest**');

      expect(_plain(spans), 'bold and italic rest');
      final nested = spans.firstWhere((span) => span.text == 'and italic');
      expect(nested.bold, isTrue);
      expect(nested.italic, isTrue);
      expect(spans.first.bold, isTrue);
      expect(spans.first.italic, isFalse);
    });

    test('parses inline code and does not style inside it', () {
      final spans = parseTranscriptMarkdownInline('run `a ** b _c_` now');

      final code = spans.firstWhere((span) => span.code);
      expect(code.text, 'a ** b _c_');
      expect(code.bold, isFalse);
      expect(code.italic, isFalse);
    });

    test('does not let emphasis bleed across an inline code span', () {
      final spans = parseTranscriptMarkdownInline('`*` literal star');
      expect(_plain(spans), '* literal star');
      expect(spans.first.code, isTrue);
    });

    test('parses links', () {
      final spans = parseTranscriptMarkdownInline(
        'see [the docs](https://example.com/a_b) now',
      );

      final link = spans.firstWhere((span) => span.href != null);
      expect(link.text, 'the docs');
      expect(link.href, 'https://example.com/a_b');
      expect(_plain(spans), 'see the docs now');
    });

    test('parses emphasis inside a link label', () {
      final spans = parseTranscriptMarkdownInline('[**bold link**](/path)');

      expect(_plain(spans), 'bold link (/path)');
      expect(spans.first.text, 'bold link');
      expect(spans.first.bold, isTrue);
      expect(spans.first.href, '/path');
      expect(spans.last.href, '/path');
    });

    test('shows non-HTTP targets verbatim once in authored position', () {
      const targets = [
        '/absolute/path.dart',
        '../relative path/文件.dart',
        'file:///tmp/report%20one.txt',
        r'C:\work\report.txt',
      ];

      for (final target in targets) {
        final spans = parseTranscriptMarkdownInline(
          'before [open]($target) after',
        );
        expect(_plain(spans), 'before open ($target) after');
        expect(spans.where((span) => span.href == target), isNotEmpty);
      }

      final matching = parseTranscriptMarkdownInline(
        '[/absolute/path.dart](/absolute/path.dart)',
      );
      expect(_plain(matching), '/absolute/path.dart');

      final styledMatching = parseTranscriptMarkdownInline(
        '[**/absolute/path.dart**](/absolute/path.dart)',
      );
      expect(_plain(styledMatching), '/absolute/path.dart');
    });

    test('parses strikethrough', () {
      final spans = parseTranscriptMarkdownInline('~~gone~~');
      expect(spans.single.text, 'gone');
      expect(spans.single.strikethrough, isTrue);
    });

    test('honours backslash escapes', () {
      final spans = parseTranscriptMarkdownInline(r'literal \*not italic\*');
      expect(_plain(spans), 'literal *not italic*');
      expect(spans.every((span) => !span.italic), isTrue);
    });

    test('leaves snake_case identifiers untouched', () {
      final spans = parseTranscriptMarkdownInline('call some_function_name(x)');
      expect(_plain(spans), 'call some_function_name(x)');
      expect(spans.every((span) => !span.italic), isTrue);
    });

    test('merges adjacent runs that share styling', () {
      final spans = parseTranscriptMarkdownInline('plain text with no markers');
      expect(spans, hasLength(1));
    });

    group('malformed input degrades to literal text', () {
      const cases = <String, String>{
        'unterminated bold': '**never closed',
        'unterminated italic': '*never closed',
        'unterminated code': '`never closed',
        'unterminated strike': '~~never closed',
        'stray closing bold': 'text ** more',
        'empty emphasis': '****',
        'lone asterisk': '*',
        'lone underscore': '_',
        'bracket without link': '[not a link] here',
        'link without href': '[label]()',
        'unclosed link paren': '[label](https://example.com',
        'only markers': '***___~~~```',
      };

      for (final entry in cases.entries) {
        final name = entry.key;
        final source = entry.value;
        test(name, () {
          expect(
            () => parseTranscriptMarkdownInline(source),
            returnsNormally,
            reason: name,
          );
          // Malformed markers still yield literal text rather than nothing.
          expect(
            parseTranscriptMarkdownInline(source),
            isNotEmpty,
            reason: name,
          );
        });
      }
    });

    test('never throws on adversarial block input', () {
      const sources = <String>[
        '```',
        '```````',
        '> ',
        '- ',
        '1. ',
        '#',
        '#######  too deep',
        '\n\n\n',
        '[](',
        '~~~~~~',
        '**[*`~',
      ];

      for (final source in sources) {
        expect(
          () => parseTranscriptMarkdown(source),
          returnsNormally,
          reason: source,
        );
      }
    });

    test('handles deeply nested emphasis without stack overflow', () {
      final source = '${'**' * 40}deep${'**' * 40}';
      expect(() => parseTranscriptMarkdownInline(source), returnsNormally);
    });
  });

  group('backslash handling (regression)', () {
    test('keeps a backslash before a non-punctuation character', () {
      expect(
        _plain(parseTranscriptMarkdownInline(r'C:\Data\config')),
        r'C:\Data\config',
      );
      expect(_plain(parseTranscriptMarkdownInline(r'\d+\s')), r'\d+\s');
      expect(_plain(parseTranscriptMarkdownInline(r'\alpha')), r'\alpha');
    });

    test('still escapes a backslashed punctuation marker', () {
      final spans = parseTranscriptMarkdownInline(r'\*not bold\*');
      expect(_plain(spans), '*not bold*');
      expect(spans.every((span) => !span.bold), isTrue);
    });
  });

  group('scan guard', () {
    test('emits an oversized line as a single literal run', () {
      final huge = '[' * 40000;
      final spans = parseTranscriptMarkdownInline(huge);
      expect(spans, hasLength(1));
      expect(spans.single.text, huge);
      expect(spans.single.bold, isFalse);
    });
  });

  group('transcriptMarkdownLooksPlain', () {
    test('is true for plain and empty text', () {
      expect(transcriptMarkdownLooksPlain(null), isTrue);
      expect(transcriptMarkdownLooksPlain(''), isTrue);
      expect(transcriptMarkdownLooksPlain('hello world'), isTrue);
    });

    test('is true for a lone pipe line that is not a table', () {
      // A pipe with no delimiter row underneath is ordinary prose.
      expect(transcriptMarkdownLooksPlain('a | b | c'), isTrue);
    });

    test('is false when any markdown is present', () {
      const sources = <String>[
        '**bold**',
        '# heading',
        '- item',
        '```\ncode\n```',
        '> quote',
        'a [link](https://example.com)',
        'para one\n\npara two',
        '| A | B |\n|---|---|\n| 1 | 2 |',
      ];
      for (final source in sources) {
        expect(transcriptMarkdownLooksPlain(source), isFalse, reason: source);
      }
    });
  });

  group('parseTranscriptMarkdown tables', () {
    test('parses a header, delimiter, and body rows', () {
      final blocks = parseTranscriptMarkdown(
        '| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |',
      );

      final table = blocks.single as MarkdownTable;
      expect(table.columnCount, 2);
      expect(_plain(table.header[0]), 'A');
      expect(_plain(table.header[1]), 'B');
      expect(table.rows, hasLength(2));
      expect(_plain(table.rows[0][0]), '1');
      expect(_plain(table.rows[0][1]), '2');
      expect(_plain(table.rows[1][0]), '3');
      expect(_plain(table.rows[1][1]), '4');
    });

    test('parses a table without leading/trailing pipes', () {
      final blocks = parseTranscriptMarkdown('A | B\n--- | ---\n1 | 2');
      final table = blocks.single as MarkdownTable;

      expect(table.columnCount, 2);
      expect(_plain(table.header[1]), 'B');
      expect(_plain(table.rows[0][1]), '2');
    });

    test('parses a header-only table with no body rows', () {
      final blocks = parseTranscriptMarkdown('| A | B |\n|---|---|');
      final table = blocks.single as MarkdownTable;

      expect(table.columnCount, 2);
      expect(table.rows, isEmpty);
    });

    test('without a delimiter row the lines stay a paragraph', () {
      final blocks = parseTranscriptMarkdown('| A | B |\n| 1 | 2 |');

      expect(blocks.single, isA<MarkdownParagraph>());
      expect(
        _plain((blocks.single as MarkdownParagraph).spans),
        '| A | B |\n| 1 | 2 |',
      );
    });

    test('a delimiter whose width differs from the header is not a table', () {
      // Two header cells, three delimiter cells: not a valid GFM table.
      final blocks = parseTranscriptMarkdown('| A | B |\n|---|---|---|\n| 1 |');
      expect(blocks.single, isA<MarkdownParagraph>());
    });

    test('reads per-column alignment from the delimiter row', () {
      final blocks = parseTranscriptMarkdown(
        '| L | C | R | N |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |',
      );
      final table = blocks.single as MarkdownTable;

      expect(table.alignments, <MarkdownTableAlignment>[
        MarkdownTableAlignment.left,
        MarkdownTableAlignment.center,
        MarkdownTableAlignment.right,
        MarkdownTableAlignment.none,
      ]);
    });

    test('normalizes ragged rows to the header column count', () {
      final blocks = parseTranscriptMarkdown(
        '| A | B | C |\n|---|---|---|\n| 1 |\n| a | b | c | d |',
      );
      final table = blocks.single as MarkdownTable;

      // Short row is padded with empty cells.
      expect(table.rows[0], hasLength(3));
      expect(_plain(table.rows[0][0]), '1');
      expect(_plain(table.rows[0][1]), isEmpty);
      expect(_plain(table.rows[0][2]), isEmpty);
      // Long row is truncated; the extra 'd' is dropped.
      expect(table.rows[1], hasLength(3));
      expect(_plain(table.rows[1][2]), 'c');
    });

    test('parses inline styling and links inside cells', () {
      final blocks = parseTranscriptMarkdown(
        '| Name | Note |\n|---|---|\n| **bob** | see [docs](https://x.io) |',
      );
      final table = blocks.single as MarkdownTable;

      final nameCell = table.rows[0][0];
      expect(_plain(nameCell), 'bob');
      expect(nameCell.single.bold, isTrue);

      final link = table.rows[0][1].firstWhere((span) => span.href != null);
      expect(link.text, 'docs');
      expect(link.href, 'https://x.io');
    });

    test('unescapes an escaped pipe inside a cell', () {
      final blocks = parseTranscriptMarkdown(
        '| A | B |\n|---|---|\n| a \\| b | c |',
      );
      final table = blocks.single as MarkdownTable;

      expect(_plain(table.rows[0][0]), 'a | b');
      expect(_plain(table.rows[0][1]), 'c');
    });

    test('splits a paragraph from a following table', () {
      final blocks = parseTranscriptMarkdown(
        'Intro line\n| A | B |\n|---|---|\n| 1 | 2 |',
      );

      expect(blocks, hasLength(2));
      expect(blocks[0], isA<MarkdownParagraph>());
      expect(_plain((blocks[0] as MarkdownParagraph).spans), 'Intro line');
      expect(blocks[1], isA<MarkdownTable>());
    });

    test('ends the table at a blank line before following prose', () {
      final blocks = parseTranscriptMarkdown(
        '| A | B |\n|---|---|\n| 1 | 2 |\n\nAfter the table.',
      );

      expect(blocks, hasLength(2));
      final table = blocks[0] as MarkdownTable;
      expect(table.rows, hasLength(1));
      expect(blocks[1], isA<MarkdownParagraph>());
    });

    test('a lone dashed line stays a thematic break, not a table', () {
      final blocks = parseTranscriptMarkdown('above\n\n---\n\nbelow');
      expect(blocks[1], isA<MarkdownThematicBreak>());
    });

    test('never throws on malformed table-like input', () {
      const sources = <String>[
        '|',
        '|---',
        '| a |\n|',
        '||\n||',
        '| a |\n| :?: |',
        '|--\n',
        '| a | b |\n| --- |',
        '| \\| |\n|---|',
        '   |\n   |---|',
      ];

      for (final source in sources) {
        expect(
          () => parseTranscriptMarkdown(source),
          returnsNormally,
          reason: source,
        );
      }
    });
  });

  group('isTranscriptHttpUrl', () {
    test('accepts http and https URLs', () {
      expect(isTranscriptHttpUrl('http://example.com'), isTrue);
      expect(isTranscriptHttpUrl('https://example.com/a/b?q=1#x'), isTrue);
      expect(isTranscriptHttpUrl('HTTPS://EXAMPLE.COM'), isTrue);
      expect(isTranscriptHttpUrl('  https://example.com  '), isTrue);
    });

    test('rejects local paths, file URLs, and other schemes', () {
      const nonWeb = <String?>[
        null,
        '',
        '   ',
        '/var/data/file',
        r'C:\Data\config',
        './relative/path',
        '../up/one',
        'relative/path',
        'file:///var/data/file',
        'mailto:someone@example.com',
        'ftp://host/file',
        'javascript:alert(1)',
        'example.com',
      ];
      for (final href in nonWeb) {
        expect(isTranscriptHttpUrl(href), isFalse, reason: '$href');
      }
    });
  });
}
