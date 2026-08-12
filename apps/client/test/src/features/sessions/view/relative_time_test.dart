import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/sessions/view/relative_time.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('relative-time boundaries stay aligned in English and Chinese', (
    tester,
  ) async {
    final now = DateTime(2026, 8, 10, 12);
    for (final testCase in const [
      (
        Locale('en'),
        <(Duration, String)>[
          (Duration(seconds: 59), 'just now'),
          (Duration(minutes: 1), '1m ago'),
          (Duration(hours: 1), '1h ago'),
          (Duration(days: 1), '1d ago'),
        ],
      ),
      (
        Locale('zh'),
        <(Duration, String)>[
          (Duration(seconds: 59), '刚刚'),
          (Duration(minutes: 1), '1 分钟前'),
          (Duration(hours: 1), '1 小时前'),
          (Duration(days: 1), '1 天前'),
        ],
      ),
    ]) {
      await tester.pumpWidget(
        MaterialApp(
          locale: testCase.$1,
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: Builder(
            builder: (context) {
              final l10n = AppLocalizations.of(context);
              return Column(
                children: [
                  for (final entry in testCase.$2)
                    Text(
                      relativeTimeLabel(
                        context,
                        l10n,
                        now.subtract(entry.$1).millisecondsSinceEpoch,
                        now: now,
                      ),
                    ),
                ],
              );
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      for (final entry in testCase.$2) {
        expect(find.text(entry.$2), findsOneWidget);
      }
    }
  });
}
