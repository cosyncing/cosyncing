import 'dart:math' as math;

import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

double _luminance(Color color) {
  double channel(double value) => value <= 0.04045
      ? value / 12.92
      : math.pow((value + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * channel(color.r) +
      0.7152 * channel(color.g) +
      0.0722 * channel(color.b);
}

double _contrast(Color foreground, Color background) {
  final foregroundLuminance = _luminance(foreground);
  final backgroundLuminance = _luminance(background);
  final high = math.max(foregroundLuminance, backgroundLuminance);
  final low = math.min(foregroundLuminance, backgroundLuminance);
  return (high + 0.05) / (low + 0.05);
}

void main() {
  group('transcript box contrast', () {
    for (final spec in kAppThemes) {
      for (final brightness in Brightness.values) {
        final tokens = brightness == Brightness.dark ? spec.dark : spec.light;
        final label = '${spec.id} ${brightness.name}';
        testWidgets('$label keeps compact box text readable', (tester) async {
          await tester.pumpWidget(
            MaterialApp(
              theme: buildAppTheme(tokens, brightness),
              home: const Scaffold(
                body: TranscriptBox(
                  tone: TranscriptBoxTone.error,
                  icon: Icons.error_outline,
                  title: 'Session error',
                  body: Text('No further detail was provided.'),
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
          final effectiveFill = Color.alphaBlend(card.color!, tokens.canvas);
          final heading = tester.widget<Text>(find.text('Session error'));
          final body = tester.widget<DefaultTextStyle>(
            find
                .descendant(
                  of: find.byType(TranscriptBox),
                  matching: find.byType(DefaultTextStyle),
                )
                .last,
          );
          expect(
            _contrast(tokens.textPrimary, tokens.surface2),
            greaterThanOrEqualTo(4.5),
            reason: '$label neutral body text',
          );
          expect(
            _contrast(body.style.color!, effectiveFill),
            greaterThanOrEqualTo(4.5),
            reason: '$label error body text',
          );
          expect(
            _contrast(heading.style!.color!, effectiveFill),
            greaterThanOrEqualTo(4.5),
            reason: '$label error heading and icon',
          );
        });
      }
    }
  });
}
