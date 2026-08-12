import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _host(
  Widget child, {
  Brightness brightness = Brightness.light,
  bool disableAnimations = false,
  TargetPlatform platform = TargetPlatform.linux,
}) {
  return MaterialApp(
    theme: buildAppTheme(
      brightness == Brightness.light
          ? themeSpecById(kDefaultThemeId).light
          : themeSpecById(kDefaultThemeId).dark,
      brightness,
    ).copyWith(platform: platform),
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(
        context,
      ).copyWith(disableAnimations: disableAnimations),
      child: child!,
    ),
    home: Scaffold(body: Center(child: child)),
  );
}

BoxDecoration _fillDecoration(WidgetTester tester) {
  final container = tester.widget<Container>(
    find.byKey(StatusDot.fillKey),
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

      final decoration = _fillDecoration(tester);
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
            ringGapColor: Color(0xFF111111),
          ),
        ),
      );

      expect(tester.getSize(find.byKey(StatusDot.ringKey)), const Size(16, 16));
      expect(tester.getSize(find.byKey(StatusDot.fillKey)), const Size(8, 8));
      final outer = tester.widget<Container>(find.byKey(StatusDot.ringKey));
      expect(
        (outer.decoration! as BoxDecoration).color,
        const Color(0xFFFFFFFF),
      );
      final gap = tester.widget<Container>(
        find
            .descendant(
              of: find.byKey(StatusDot.ringKey),
              matching: find.byType(Container),
            )
            .first,
      );
      expect(
        (gap.decoration! as BoxDecoration).color,
        const Color(0xFF111111),
      );
    });

    testWidgets('working pulse follows the reviewed opacity cycle', (
      tester,
    ) async {
      for (final brightness in [Brightness.light, Brightness.dark]) {
        await tester.pumpWidget(
          _host(
            const StatusDot(color: Color(0xFF0D9488), pulse: true),
            brightness: brightness,
          ),
        );
        final fade = find.descendant(
          of: find.byType(StatusDot),
          matching: find.byType(FadeTransition),
        );
        expect(fade, findsOneWidget, reason: '$brightness');
        final samples = <double>[];
        for (var index = 0; index < 8; index += 1) {
          samples.add(tester.widget<FadeTransition>(fade).opacity.value);
          await tester.pump(const Duration(milliseconds: 200));
        }
        expect(samples.reduce((a, b) => a < b ? a : b), closeTo(.35, .01));
        expect(samples.reduce((a, b) => a > b ? a : b), closeTo(1, .01));
      }
    });

    testWidgets('reduced motion and offstage ticker mode render statically', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          const StatusDot(color: Color(0xFF0D9488), pulse: true),
          disableAnimations: true,
        ),
      );
      expect(
        find.descendant(
          of: find.byType(StatusDot),
          matching: find.byType(FadeTransition),
        ),
        findsNothing,
      );

      await tester.pumpWidget(
        _host(
          const TickerMode(
            enabled: false,
            child: StatusDot(color: Color(0xFF0D9488), pulse: true),
          ),
        ),
      );
      expect(
        find.descendant(
          of: find.byType(StatusDot),
          matching: find.byType(FadeTransition),
        ),
        findsNothing,
      );
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

  group('TranscriptBox', () {
    testWidgets('uses the compact token shell without nesting selection', (
      tester,
    ) async {
      await tester.pumpWidget(
        _host(
          const SelectionArea(
            child: TranscriptBox(
              tone: TranscriptBoxTone.neutral,
              icon: Icons.quiz_outlined,
              title: 'Question',
              body: Text('Which server?'),
              actions: [TextButton(onPressed: null, child: Text('Submit'))],
            ),
          ),
        ),
      );

      final card = tester.widget<Card>(
        find.descendant(
          of: find.byType(TranscriptBox),
          matching: find.byType(Card),
        ),
      );
      final tokens = themeSpecById(kDefaultThemeId).light;
      expect(card.margin, const EdgeInsets.fromLTRB(8, 8, 8, 0));
      expect(
        (card.shape! as RoundedRectangleBorder).borderRadius,
        BorderRadius.circular(tokens.radiusLg),
      );
      final padding = card.child! as Padding;
      expect(
        padding.padding,
        const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      );
      expect(
        find.descendant(
          of: find.byType(TranscriptBox),
          matching: find.byType(SelectionArea),
        ),
        findsNothing,
      );
    });

    testWidgets('applies neutral and error semantic colors', (tester) async {
      for (final tone in TranscriptBoxTone.values) {
        await tester.pumpWidget(
          _host(
            TranscriptBox(
              tone: tone,
              icon: Icons.info_outline,
              title: tone.name,
              body: const Text('detail'),
            ),
            brightness: Brightness.dark,
          ),
        );

        final card = tester.widget<Card>(
          find.descendant(
            of: find.byType(TranscriptBox),
            matching: find.byType(Card),
          ),
        );
        final tokens = themeSpecById(kDefaultThemeId).dark;
        expect(
          card.color,
          tone == TranscriptBoxTone.error
              ? tokens.statusError.withValues(alpha: 0.35)
              : tokens.surface2,
        );
        final title = tester.widget<Text>(find.text(tone.name));
        expect(
          title.style?.color,
          tone == TranscriptBoxTone.error
              ? tester.widget<Icon>(find.byIcon(Icons.info_outline)).color
              : tokens.textPrimary,
        );
      }
    });
  });

  group('CopyableCodeLine', () {
    testWidgets('uses tokens and never truncates a selectable literal', (
      tester,
    ) async {
      const literal =
          '/work/a-very-long-directory/with/nested/source/that-must-scroll';
      await tester.pumpWidget(
        _host(
          const SizedBox(
            width: 220,
            child: CopyableCodeLine(
              key: Key('code-line'),
              text: literal,
              copyTooltip: 'Copy command',
              copiedMessage: 'Command copied',
            ),
          ),
          brightness: Brightness.dark,
        ),
      );

      final container = tester.widget<Container>(
        find.descendant(
          of: find.byKey(const Key('code-line')),
          matching: find.byType(Container),
        ),
      );
      final decoration = container.decoration! as BoxDecoration;
      final tokens = themeSpecById(kDefaultThemeId).dark;
      expect(decoration.color, tokens.surface2);
      expect(
        decoration.borderRadius,
        BorderRadius.circular(tokens.radiusSm),
      );
      expect(find.widgetWithText(SelectableText, literal), findsOneWidget);
      expect(find.byType(SingleChildScrollView), findsOneWidget);
      final selectable = find.widgetWithText(SelectableText, literal);
      await tester.longPressAt(
        tester.getTopLeft(selectable) + const Offset(20, 8),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
    });

    testWidgets('copies the exact value and confirms the action', (
      tester,
    ) async {
      const literal = 'cat ~/.cosyncing/secrets/broker-token';
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied =
                (call.arguments as Map<Object?, Object?>)['text'] as String?;
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );

      await tester.pumpWidget(
        _host(
          const CopyableCodeLine(
            text: literal,
            copyTooltip: 'Copy command',
            copiedMessage: 'Command copied',
          ),
        ),
      );
      await tester.tap(find.byTooltip('Copy command'));
      await tester.pump();

      expect(copied, literal);
      expect(find.text('Command copied'), findsOneWidget);
    });

    testWidgets('uses 32dp pointer and 40dp touch copy targets', (
      tester,
    ) async {
      for (final testCase in const [
        (TargetPlatform.linux, 32.0),
        (TargetPlatform.windows, 32.0),
        (TargetPlatform.android, 40.0),
        (TargetPlatform.iOS, 40.0),
      ]) {
        await tester.pumpWidget(
          _host(
            const CopyableCodeLine(
              text: 'cosy pair',
              copyTooltip: 'Copy command',
              copiedMessage: 'Command copied',
            ),
            platform: testCase.$1,
          ),
        );
        await tester.pumpAndSettle();
        expect(
          tester.getSize(find.byType(IconButton)),
          Size.square(testCase.$2),
          reason: '${testCase.$1}',
        );
      }
    });

    testWidgets('copy action is keyboard reachable', (tester) async {
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied =
                (call.arguments as Map<Object?, Object?>)['text'] as String?;
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      await tester.pumpWidget(
        _host(
          const CopyableCodeLine(
            text: 'cosy pair',
            copyTooltip: 'Copy command',
            copiedMessage: 'Command copied',
          ),
        ),
      );

      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();

      expect(copied, 'cosy pair');
    });
  });

  group('SelectableTapRegion', () {
    testWidgets('short taps activate and drag selection does not', (
      tester,
    ) async {
      var taps = 0;
      await tester.pumpWidget(
        _host(
          Material(
            // Mirrors real usage: the selection region belongs to the list,
            // and the row's own tap handler is the only one — the region no
            // longer re-supplies it.
            child: SelectionArea(
              child: InkWell(
                onTap: () => taps += 1,
                child: const SelectableTapRegion(
                  child: Text('Selectable row title'),
                ),
              ),
            ),
          ),
        ),
      );

      await tester.tap(find.text('Selectable row title'));
      await tester.pump();
      expect(taps, 1);

      final start = tester.getTopLeft(find.text('Selectable row title'));
      final gesture = await tester.startGesture(start + const Offset(4, 8));
      await gesture.moveBy(const Offset(60, 0));
      await gesture.up();
      await tester.pump();
      expect(taps, 1);

      await tester.longPress(find.text('Selectable row title'));
      await tester.pump();
      expect(taps, 1, reason: 'touch selection must not activate the row');
    });

    testWidgets('carries no selection island of its own', (tester) async {
      await tester.pumpWidget(
        _host(
          Material(
            child: SelectionArea(
              child: Column(
                children: [
                  for (final title in ['first row', 'second row'])
                    SelectableTapRegion(child: Text(title)),
                ],
              ),
            ),
          ),
        ),
      );

      // A region per row is the defect: SelectionArea only ever clears the
      // selection it owns, so a second selection left the first row still
      // painted, and no drag could range across rows.
      expect(
        find.descendant(
          of: find.byType(SelectableTapRegion),
          matching: find.byType(SelectionArea),
        ),
        findsNothing,
      );
      expect(find.byType(SelectionArea), findsOneWidget);
    });
  });
}
