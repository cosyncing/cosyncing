import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/derived_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final spec = themeSpecById(kDefaultThemeId);

  group('DerivedTheme', () {
    test('keeps one derived theme while its base and input are unchanged', () {
      var derivations = 0;
      final derived = DerivedTheme<double>((base, size) {
        derivations++;
        return base.copyWith(
          textTheme: base.textTheme.copyWith(
            bodyMedium: base.textTheme.bodyMedium?.copyWith(fontSize: size),
          ),
        );
      });
      final base = buildAppTheme(spec.light, Brightness.light);

      final first = derived.of(base, 14);
      expect(first.textTheme.bodyMedium?.fontSize, 14);
      expect(identical(derived.of(base, 14), first), isTrue);
      // An equal base read again (a fresh localized copy) is the same base.
      expect(identical(derived.of(base.copyWith(), 14), first), isTrue);
      expect(derivations, 1);

      final larger = derived.of(base, 16);
      expect(larger.textTheme.bodyMedium?.fontSize, 16);
      expect(derivations, 2);

      final dark = derived.of(buildAppTheme(spec.dark, Brightness.dark), 16);
      expect(dark.brightness, Brightness.dark);
      expect(dark.textTheme.bodyMedium?.fontSize, 16);
      expect(derivations, 3);
    });

    testWidgets('gives a rebuilt subtree the identical theme', (tester) async {
      final derived = DerivedTheme<void>(
        (base, _) => base.copyWith(dividerColor: Colors.transparent),
      );
      final seen = <ThemeData>[];
      Widget app(int generation) => MaterialApp(
        theme: buildAppTheme(spec.light, Brightness.light),
        home: Builder(
          builder: (context) => Theme(
            data: derived.of(Theme.of(context), null),
            child: Builder(
              builder: (context) {
                seen.add(Theme.of(context));
                return Text('$generation');
              },
            ),
          ),
        ),
      );

      await tester.pumpWidget(app(1));
      await tester.pumpWidget(app(2));

      expect(seen, hasLength(2));
      expect(seen.last.dividerColor, Colors.transparent);
      expect(
        identical(seen.first, seen.last),
        isTrue,
        reason: 'the localized theme below is reused, not copied again',
      );
    });
  });
}
