import 'package:cosyncing_client/src/features/sessions/artifacts/file_source_body.dart';
import 'package:flutter_test/flutter_test.dart';

/// A stand-in for a real font: ASCII on the monospace advance, anything else
/// twice as wide.
///
/// `flutter_test` paints with a font where every glyph has the same advance,
/// CJK included, so a test that measures for real cannot tell the rule under
/// test from the character-count estimate it replaced. This can.
double _fakeMeasure(String line, double advance) {
  var width = 0.0;
  for (final unit in line.codeUnits) {
    width += unit > 0x7f ? advance * 2 : advance;
  }
  return width;
}

void main() {
  group('the source body content width', () {
    const advance = 10.0;

    test('a wide line that is short in characters still sets the extent', () {
      // The exact case a character-count estimate gets backwards: fewer
      // characters, more pixels. The estimate returns 400 for the ASCII line
      // and 230 for the CJK one, so on the estimate alone the extent is 400
      // and the last 60px of the CJK line sit past the end of the scrollable
      // area with no way to reach them. That is the bug, in numbers.
      const wide = '这是一个中文注释，说明这个函数的用途和边界情况'; // 23 chars, 460px
      const ascii = '// ascii, longer by character count!!!!!'; // 40, 400px
      expect(wide.length, lessThan(ascii.length));

      final width = fileSourceContentWidth(
        lines: const [ascii, wide],
        advance: advance,
        measure: (line) => _fakeMeasure(line, advance),
      );

      expect(width, _fakeMeasure(wide, advance));
      expect(width, greaterThan(ascii.length * advance));
    });

    test('ASCII lines are estimated, never measured', () {
      // The reason this is affordable on a 20k-line file. If the routing ever
      // inverts, the cost goes up by four orders of magnitude silently.
      final measured = <String>[];
      final width = fileSourceContentWidth(
        lines: const ['plain ascii', 'also plain', 'still plain'],
        advance: advance,
        measure: (line) {
          measured.add(line);
          return 9999;
        },
      );

      expect(measured, isEmpty);
      expect(width, 'still plain'.length * advance);
    });

    test('only the lines that need it are measured', () {
      final measured = <String>[];
      fileSourceContentWidth(
        // Precomposed e-acute, then e + U+0301, then an emoji. The second is
        // the interesting one: two code units that paint as one glyph, so its
        // character count overstates its width where the others understate it.
        lines: const [
          'ascii',
          '\u4e2d\u6587',
          'more ascii',
          '\u00e9',
          'e\u0301',
          '\u{1f642}',
        ],
        advance: advance,
        measure: (line) {
          measured.add(line);
          return _fakeMeasure(line, advance);
        },
      );

      // None of these is knowable from a character count, in either direction,
      // so all of them go to the font.
      expect(measured, ['\u4e2d\u6587', '\u00e9', 'e\u0301', '\u{1f642}']);
    });

    test('the widest wins whichever kind it is', () {
      // An ASCII line long enough to beat every measured one still has to set
      // the extent, so the estimate cannot be skipped once a wide line exists.
      const wide = '中文';
      final ascii = 'x' * 100;
      final width = fileSourceContentWidth(
        lines: [wide, ascii],
        advance: advance,
        measure: (line) => _fakeMeasure(line, advance),
      );

      expect(width, 100 * advance);
    });

    test('no lines is no width, not a crash', () {
      expect(
        fileSourceContentWidth(
          lines: const [],
          advance: advance,
          measure: (_) => fail('nothing to measure'),
        ),
        0,
      );
    });
  });
}
