import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _host(Widget child) => MaterialApp(
  theme: ThemeData(extensions: [themeSpecById(kDefaultThemeId).light]),
  home: Scaffold(body: Center(child: child)),
);

void main() {
  group('FileMarkGlyph', () {
    testWidgets('sizes every call site from one page ratio', (tester) async {
      final tokens = themeSpecById(kDefaultThemeId).light;
      // The three sizes the design calls for: tab, header, state panel.
      for (final height in <double>[11, 13, 31]) {
        await tester.pumpWidget(
          _host(
            FileMarkGlyph(
              color: tokens.textSecondary,
              foldColor: tokens.surface,
              height: height,
            ),
          ),
        );
        final size = tester.getSize(find.byKey(FileMarkGlyph.markKey));
        expect(size.height, height);
        expect(size.width, closeTo(FileMarkGlyph.widthFor(height), 0.01));
      }
      expect(FileMarkGlyph.widthFor(13), closeTo(11, 0.01));
      expect(FileMarkGlyph.widthFor(31), closeTo(26.2, 0.05));
    });

    testWidgets('paints in both brightnesses without overflow', (tester) async {
      for (final spec in kAppThemes) {
        for (final tokens in [spec.light, spec.dark]) {
          await tester.pumpWidget(
            MaterialApp(
              theme: ThemeData(extensions: [tokens]),
              home: Scaffold(
                body: Center(
                  child: FileMarkGlyph(
                    color: tokens.textSecondary,
                    foldColor: tokens.surface2,
                  ),
                ),
              ),
            ),
          );
          expect(tester.takeException(), isNull, reason: spec.id);
        }
      }
    });

    testWidgets('holds no ticker', (tester) async {
      final tokens = themeSpecById(kDefaultThemeId).light;
      await tester.pumpWidget(
        _host(
          FileMarkGlyph(
            color: tokens.textSecondary,
            foldColor: tokens.surface,
          ),
        ),
      );
      // The file surface never animates. A glyph that could would be the
      // first thing to break the "a file never looks busy" contract.
      expect(tester.binding.transientCallbackCount, 0);
    });
  });
}
