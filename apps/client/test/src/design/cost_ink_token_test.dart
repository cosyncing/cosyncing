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
  group('costInk', () {
    for (final spec in kAppThemes) {
      for (final brightness in Brightness.values) {
        final tokens = brightness == Brightness.dark ? spec.dark : spec.light;
        final label = '${spec.id} ${brightness.name}';

        test('$label cost figures read on the planes they are printed on', () {
          // Cost is text — a headline figure on the export card and a tile
          // value on the report — so the bar is the 4.5:1 text bar, against
          // both planes the figure can land on.
          for (final plane in [tokens.surface, tokens.canvas]) {
            expect(
              _contrast(tokens.costInk, plane),
              greaterThanOrEqualTo(4.5),
              reason: '$label costInk must stay readable as a figure',
            );
          }
        });

        test('$label is not just the accent or the primary text re-worn', () {
          // The token exists so cost reads as its own figure beside the
          // accent-spending token count; collapsing into either role deletes
          // the distinction it was made for. The monochrome themes answer in
          // value alone, so there a step away from textSecondary is the check.
          expect(tokens.costInk, isNot(tokens.accent), reason: label);
          expect(tokens.costInk, isNot(tokens.textPrimary), reason: label);
          expect(tokens.costInk, isNot(tokens.textSecondary), reason: label);
        });
      }
    }

    test('copyWith and lerp carry costInk', () {
      final light = themeSpecById(kDefaultThemeId).light;
      final dark = themeSpecById(kDefaultThemeId).dark;

      final copied = light.copyWith(costInk: dark.costInk);
      expect(copied.costInk, dark.costInk);
      expect(copied.accent, light.accent);

      final halfway = light.lerp(dark, 0.5);
      expect(halfway.costInk, Color.lerp(light.costInk, dark.costInk, 0.5));
    });
  });
}
