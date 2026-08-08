import 'package:cosyncing_client/src/design/ui_scale.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('UiTextScale', () {
    test('system follows the OS (null factor)', () {
      expect(UiTextScale.system.factor, isNull);
    });

    test('fixed steps expose their linear factor', () {
      expect(UiTextScale.small.factor, 0.85);
      expect(UiTextScale.standard.factor, 1.0);
      expect(UiTextScale.large.factor, 1.15);
      expect(UiTextScale.extraLarge.factor, 1.3);
    });

    test('token round-trips through fromToken', () {
      for (final scale in UiTextScale.values) {
        expect(UiTextScale.fromToken(scale.token), scale);
      }
    });

    test('unknown or null token falls back to system', () {
      expect(UiTextScale.fromToken(null), UiTextScale.system);
      expect(UiTextScale.fromToken('nonsense'), UiTextScale.system);
    });

    test('ladder excludes system and is ordered by factor', () {
      expect(UiTextScale.ladder, isNot(contains(UiTextScale.system)));
      expect(
        UiTextScale.ladder,
        const [
          UiTextScale.small,
          UiTextScale.standard,
          UiTextScale.large,
          UiTextScale.extraLarge,
        ],
      );
      final factors = UiTextScale.ladder.map((v) => v.factor!).toList();
      expect(factors, orderedEquals(List.of(factors)..sort()));
    });

    test('nearestTo picks the closest rung and clamps outside the range', () {
      expect(UiTextScale.nearestTo(1), UiTextScale.standard);
      expect(UiTextScale.nearestTo(0.86), UiTextScale.small);
      expect(UiTextScale.nearestTo(1.14), UiTextScale.large);
      expect(UiTextScale.nearestTo(0.1), UiTextScale.small);
      expect(UiTextScale.nearestTo(9), UiTextScale.extraLarge);
    });

    test('nearestTo resolves ties to the smaller rung', () {
      // Exactly between standard (1.0) and large (1.15).
      expect(UiTextScale.nearestTo(1.075), UiTextScale.standard);
    });
  });

  group('UiDensity', () {
    test('comfortable maps to the platform-adaptive density', () {
      expect(
        UiDensity.comfortable.visualDensity,
        VisualDensity.adaptivePlatformDensity,
      );
    });

    test('compact tightens and spacious loosens', () {
      expect(UiDensity.compact.visualDensity.horizontal, lessThan(0));
      expect(UiDensity.spacious.visualDensity.horizontal, greaterThan(0));
    });

    test('token round-trips through fromToken', () {
      for (final density in UiDensity.values) {
        expect(UiDensity.fromToken(density.token), density);
      }
    });

    test('unknown or null token falls back to comfortable', () {
      expect(UiDensity.fromToken(null), UiDensity.comfortable);
      expect(UiDensity.fromToken('nonsense'), UiDensity.comfortable);
    });
  });

  group('UiScaleSettings', () {
    test('defaults follow the OS text size at comfortable density', () {
      expect(kDefaultUiScaleSettings.textScale, UiTextScale.system);
      expect(kDefaultUiScaleSettings.density, UiDensity.comfortable);
    });

    test('copyWith overrides only the given fields', () {
      const base = UiScaleSettings();
      final scaled = base.copyWith(textScale: UiTextScale.large);
      expect(scaled.textScale, UiTextScale.large);
      expect(scaled.density, UiDensity.comfortable);
    });

    test('value equality holds for identical settings', () {
      expect(
        const UiScaleSettings(
          textScale: UiTextScale.large,
          density: UiDensity.spacious,
        ),
        const UiScaleSettings(
          textScale: UiTextScale.large,
          density: UiDensity.spacious,
        ),
      );
    });
  });
}
