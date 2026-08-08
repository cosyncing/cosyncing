import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _host(Widget child) {
  return MaterialApp(
    theme: buildAppTheme(
      themeSpecById(kDefaultThemeId).light,
      Brightness.light,
    ),
    home: Scaffold(body: Center(child: child)),
  );
}

BoxDecoration _decorationOf(WidgetTester tester, Type ancestor) {
  final container = tester.widget<Container>(
    find.descendant(
      of: find.byType(ancestor),
      matching: find.byType(Container),
    ),
  );
  return container.decoration! as BoxDecoration;
}

void main() {
  group('StatusDot', () {
    testWidgets('fills with the given color and no ring by default', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(const StatusDot(color: Color(0xFF0D9488))),
      );

      final decoration = _decorationOf(tester, StatusDot);
      expect(decoration.color, const Color(0xFF0D9488));
      expect(decoration.shape, BoxShape.circle);
      expect(decoration.border, isNull);
    });

    testWidgets('draws a ring when ringColor is set', (tester) async {
      await tester.pumpWidget(
        _host(
          const StatusDot(
            color: Color(0xFF0D9488),
            ringColor: Color(0xFFFFFFFF),
          ),
        ),
      );

      expect(_decorationOf(tester, StatusDot).border, isNotNull);
    });
  });

  group('StatusPill', () {
    testWidgets('shows the label in the semantic color', (tester) async {
      await tester.pumpWidget(
        _host(const StatusPill(label: 'Working', color: Color(0xFF0D9488))),
      );

      expect(find.text('Working'), findsOneWidget);
      final text = tester.widget<Text>(find.text('Working'));
      expect(text.style?.color, const Color(0xFF0D9488));
      expect(text.style?.fontWeight, FontWeight.w600);
    });

    testWidgets('renders an optional leading icon', (tester) async {
      await tester.pumpWidget(
        _host(
          const StatusPill(
            label: 'Sent',
            color: Color(0xFF0D9488),
            icon: Icons.check,
          ),
        ),
      );

      expect(find.byIcon(Icons.check), findsOneWidget);
    });
  });

  group('MetadataChip', () {
    testWidgets('shows its label unconstrained by default', (tester) async {
      await tester.pumpWidget(_host(const MetadataChip(label: 'gpt-5')));

      expect(find.text('gpt-5'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(MetadataChip),
          matching: find.byType(ConstrainedBox),
        ),
        findsNothing,
      );
    });

    testWidgets('constrains width and ellipsizes when maxWidth is set', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(const MetadataChip(label: 'a-very-long-value', maxWidth: 80)),
      );

      final box = tester.widget<ConstrainedBox>(
        find.descendant(
          of: find.byType(MetadataChip),
          matching: find.byType(ConstrainedBox),
        ),
      );
      expect(box.constraints.maxWidth, 80);
      final text = tester.widget<Text>(find.text('a-very-long-value'));
      expect(text.overflow, TextOverflow.ellipsis);
    });
  });

  group('SectionHeader', () {
    testWidgets('shows the title', (tester) async {
      await tester.pumpWidget(_host(const SectionHeader('Appearance')));

      expect(find.text('Appearance'), findsOneWidget);
    });
  });
}
