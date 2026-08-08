import 'dart:math' as math;

import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// WCAG relative luminance of [color] (sRGB).
double _luminance(Color color) {
  double channel(double value) => value <= 0.04045
      ? value / 12.92
      : math.pow((value + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * channel(color.r) +
      0.7152 * channel(color.g) +
      0.0722 * channel(color.b);
}

/// WCAG contrast ratio between [foreground] and [background].
double _contrast(Color foreground, Color background) {
  final lf = _luminance(foreground);
  final lb = _luminance(background);
  final hi = math.max(lf, lb);
  final lo = math.min(lf, lb);
  return (hi + 0.05) / (lo + 0.05);
}

void main() {
  group('semantic syntax tokens', () {
    for (final spec in kAppThemes) {
      for (final brightness in Brightness.values) {
        final tokens = brightness == Brightness.dark ? spec.dark : spec.light;
        final label = '${spec.id} ${brightness.name}';
        final syntax = <String, Color>{
          'syntaxKeyword': tokens.syntaxKeyword,
          'syntaxString': tokens.syntaxString,
          'syntaxNumber': tokens.syntaxNumber,
          'syntaxComment': tokens.syntaxComment,
          'syntaxLiteral': tokens.syntaxLiteral,
        };

        test('$label supplies readable syntax tokens on surface2', () {
          for (final entry in syntax.entries) {
            expect(
              _contrast(entry.value, tokens.surface2),
              greaterThanOrEqualTo(4.5),
              reason:
                  '$label ${entry.key} must meet 4.5:1 against the surface2 '
                  'code plane',
            );
          }
        });

        test('$label syntax tokens are pairwise distinct', () {
          final values = syntax.values.map((color) => color.toARGB32()).toSet();
          expect(
            values,
            hasLength(syntax.length),
            reason:
                '$label must not collapse two syntax categories into one '
                'hue',
          );
        });

        test(
          '$label literals and strings do not reuse alarm or accent hues',
          () {
            // The defects this schema removes: literals rendered in error red,
            // and the keyword/string collision through accent/status colors.
            expect(tokens.syntaxLiteral, isNot(tokens.statusError));
            expect(tokens.syntaxString, isNot(tokens.statusWorking));
            expect(tokens.syntaxKeyword, isNot(tokens.syntaxString));
            expect(tokens.syntaxNumber, isNot(tokens.statusNeedsInput));
          },
        );
      }
    }

    test('copyWith and lerp carry the syntax tokens', () {
      final light = themeSpecById(kDefaultThemeId).light;
      final dark = themeSpecById(kDefaultThemeId).dark;
      final copied = light.copyWith(syntaxKeyword: dark.syntaxKeyword);
      expect(copied.syntaxKeyword, dark.syntaxKeyword);
      expect(copied.syntaxString, light.syntaxString);

      final halfway = light.lerp(dark, 0.5);
      expect(
        halfway.syntaxComment,
        Color.lerp(light.syntaxComment, dark.syntaxComment, 0.5),
      );
      expect(
        halfway.syntaxLiteral,
        Color.lerp(light.syntaxLiteral, dark.syntaxLiteral, 0.5),
      );
    });
  });
}
