import 'package:cosyncing_client/src/features/sessions/renderers/transcript_markdown.dart';
import 'package:flutter_test/flutter_test.dart';

List<String> _linesOf(String source) => source.split('\n');

String _kindsOf(TranscriptCodeLineHighlighter highlighter, int index) =>
    highlighter.tokensFor(index).map((token) => token.kind.name).join(',');

void main() {
  group('TranscriptCodeLineHighlighter', () {
    test('ordinary source reaches the fenced-snippet token budget', () {
      // The premise of lexing per line. Measured against this repo on
      // 2026-09-01: a 926-line file lexes to 2,414 runs and a 1,668-line one
      // to 3,914 — then `session_detail_page.dart`, 2,547 lines and 107 KB,
      // trips the 4,096-run bound and comes back as a single grey run. The
      // 128 KB units cap is not what bites first; the token cap is, at roughly
      // a third of it. If this test ever stops failing whole-file, the
      // per-line machinery is unnecessary complexity and should go.
      final source = List.generate(
        2500,
        (i) => r"  final name$i = compute($i, 'label'); // note",
      ).join('\n');
      final whole = highlightTranscriptCodeDetailed(source, language: 'dart');
      expect(whole.declined, TranscriptCodeDecline.tooManyTokens);
      expect(whole.tokens, hasLength(1));
      expect(source.length, lessThan(maxHighlightedTranscriptCodeUnits));

      // Per line, the same file highlights in full.
      final lines = TranscriptCodeLineHighlighter(
        _linesOf(source),
        language: 'dart',
      );
      expect(lines.declined, isNull);
      expect(_kindsOf(lines, 0), contains('keyword'));
      expect(_kindsOf(lines, 2499), contains('comment'));
      expect(_kindsOf(lines, 2499), contains('string'));
    });

    test('a block comment carries across the lines it covers', () {
      final lines = _linesOf('''
final a = 1;
/* opening
still inside
*/ final b = 2;
final c = 3;''');
      final highlighter = TranscriptCodeLineHighlighter(
        lines,
        language: 'dart',
      );
      expect(_kindsOf(highlighter, 0), contains('keyword'));
      expect(_kindsOf(highlighter, 1), contains('comment'));
      expect(_kindsOf(highlighter, 2), 'comment');
      // The closer is followed by real code on the same line.
      expect(_kindsOf(highlighter, 3), startsWith('comment'));
      expect(_kindsOf(highlighter, 3), contains('keyword'));
      expect(_kindsOf(highlighter, 4), contains('keyword'));
    });

    test('a comment opener inside a string opens nothing', () {
      final lines = _linesOf("""
final a = '/* not a comment';
final b = 2;""");
      final highlighter = TranscriptCodeLineHighlighter(
        lines,
        language: 'dart',
      );
      // If the carry scan treated that as an opener, every following line in
      // the file would be one comment run.
      expect(_kindsOf(highlighter, 1), contains('keyword'));
      expect(_kindsOf(highlighter, 1), isNot(equals('comment')));
    });

    test('a late line is correct without lexing the lines above it', () {
      final lines = <String>[
        '/* a comment that never closes on its own line',
        ...List.generate(5000, (i) => 'still inside $i'),
        '*/ final tail = 1;',
      ];
      final highlighter = TranscriptCodeLineHighlighter(
        lines,
        language: 'dart',
      );
      expect(_kindsOf(highlighter, 4000), 'comment');
      expect(_kindsOf(highlighter, 5001), contains('keyword'));
    });

    test('an unterminated string stops at end of line', () {
      final lines = _linesOf("""
final a = 'unterminated
final b = 2;""");
      final highlighter = TranscriptCodeLineHighlighter(
        lines,
        language: 'dart',
      );
      // The whole-block lexer runs an unterminated quote to end of input; per
      // line it stops where an editor stops, which is strictly better.
      expect(_kindsOf(highlighter, 1), contains('keyword'));
    });

    test('one enormous line declines for size, and says so', () {
      final lines = <String>[
        'const x = 1;',
        "'${'a' * (maxHighlightedTranscriptCodeUnits + 1)}'",
      ];
      final highlighter = TranscriptCodeLineHighlighter(
        lines,
        language: 'dart',
      );
      expect(highlighter.declined, TranscriptCodeDecline.tooLarge);
    });

    test('an unknown language declines without anything to explain', () {
      final highlighter = TranscriptCodeLineHighlighter(
        _linesOf('nothing here\nor here'),
        language: 'brainfuck',
      );
      expect(highlighter.declined, TranscriptCodeDecline.noProfile);
      expect(highlighter.hasProfile, isFalse);
      expect(_kindsOf(highlighter, 0), 'plain');
    });

    test('html comments carry the same way block comments do', () {
      final lines = _linesOf('''
<div>
<!-- opening
still inside
--> <span>''');
      final highlighter = TranscriptCodeLineHighlighter(
        lines,
        language: 'html',
      );
      expect(_kindsOf(highlighter, 2), 'comment');
      expect(_kindsOf(highlighter, 3), startsWith('comment'));
    });
  });
}
