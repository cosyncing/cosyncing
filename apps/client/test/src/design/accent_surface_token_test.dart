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
  group('accentSurface', () {
    for (final spec in kAppThemes) {
      for (final brightness in Brightness.values) {
        final tokens = brightness == Brightness.dark ? spec.dark : spec.light;
        final label = '${spec.id} ${brightness.name}';

        test('$label reads as a tint of surface2, not as another plane', () {
          expect(
            tokens.accentSurface,
            isNot(tokens.surface2),
            reason: '$label accentSurface collapsed into surface2',
          );
          final ratio = _contrast(tokens.accentSurface, tokens.surface2);
          expect(
            ratio,
            greaterThanOrEqualTo(1.05),
            reason: '$label wash is invisible against surface2',
          );
          expect(
            ratio,
            lessThan(2),
            reason:
                '$label wash is strong enough to read as a separate surface '
                'rather than a highlight on the code plane',
          );
        });

        test('$label carries primary text on the wash', () {
          expect(
            _contrast(tokens.textPrimary, tokens.accentSurface),
            greaterThanOrEqualTo(4.5),
            reason: '$label textPrimary must stay readable on accentSurface',
          );
        });

        test('$label draws accent chrome on the wash', () {
          // 3:1 is the non-text bar, and it is the right one: what sits on
          // this wash is a 2dp gutter edge and an icon, not prose.
          expect(
            _contrast(tokens.accent, tokens.accentSurface),
            greaterThanOrEqualTo(3),
            reason: '$label accent chrome vanishes into its own wash',
          );
        });

        // Deliberately NOT asserted: the `syntax*` tokens on accentSurface.
        // Four light themes sit at 4.57-4.77 against surface2, so any wash
        // visible enough to read at all puts them under the 4.5 bar
        // `syntax_tokens_test.dart` enforces for every other code row —
        // worst case 3.61. There is no alpha that satisfies both; dropping it
        // far enough (0.9-1.5% in those themes) makes the highlight
        // disappear. So the anchor reveal tints the gutter, and this token
        // goes behind plain text, never behind highlighted code.
      }
    }

    test('copyWith and lerp carry accentSurface', () {
      final light = themeSpecById(kDefaultThemeId).light;
      final dark = themeSpecById(kDefaultThemeId).dark;

      final copied = light.copyWith(accentSurface: dark.accentSurface);
      expect(copied.accentSurface, dark.accentSurface);
      expect(copied.accent, light.accent);

      final halfway = light.lerp(dark, 0.5);
      expect(
        halfway.accentSurface,
        Color.lerp(light.accentSurface, dark.accentSurface, 0.5),
      );
    });
  });
}
