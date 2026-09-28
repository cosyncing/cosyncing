import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  // MaterialApp's Theme notifies every dependent when its data compares
  // unequal, so a theme that is not equal to itself rebuilt the whole app on
  // every rebuild above it — opening, closing or switching a tab.
  group('buildAppTheme', () {
    for (final spec in kAppThemes) {
      for (final brightness in Brightness.values) {
        final tokens = brightness == Brightness.dark ? spec.dark : spec.light;
        test('${spec.id} ${brightness.name} equals a rebuild of itself', () {
          expect(
            buildAppTheme(tokens, brightness),
            buildAppTheme(tokens, brightness),
          );
          expect(
            buildAppTheme(tokens, brightness, density: VisualDensity.compact),
            buildAppTheme(tokens, brightness, density: VisualDensity.compact),
          );
        });
      }
    }

    test('the scrollbar thumb strengthens while dragged', () {
      final spec = themeSpecById(kDefaultThemeId);
      final thumb = buildAppTheme(
        spec.light,
        Brightness.light,
      ).scrollbarTheme.thumbColor!;
      expect(
        thumb.resolve(const {}),
        spec.light.textTertiary.withValues(alpha: 0.3),
      );
      expect(
        thumb.resolve(const {WidgetState.dragged, WidgetState.hovered}),
        spec.light.textTertiary.withValues(alpha: 0.6),
      );
    });
  });

  test('Flat White Minimalist is the default and the fallback theme', () {
    expect(kDefaultThemeId, 'flat-white-minimalist');
    expect(kAppThemes.first.id, kDefaultThemeId);
    expect(themeSpecById('no-such-theme').id, kDefaultThemeId);
    expect(themeSpecById(null).id, kDefaultThemeId);
  });
}
