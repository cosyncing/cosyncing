import 'dart:convert';
import 'dart:io';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_export_service.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_period.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_source_catalog.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_activity.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_agent_table.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_heatmap.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Widget subject(Widget child) => ProviderScope(
    overrides: [usageExportSupportedProvider.overrideWithValue(false)],
    child: MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      theme: buildAppTheme(
        themeSpecById(kDefaultThemeId).light,
        Brightness.light,
      ),
      home: Scaffold(body: SingleChildScrollView(child: child)),
    ),
  );

  test('catalog separates usage integrations from quota identities', () {
    expect(usageSourceNames, hasLength(28));
    expect(usageSourceDisplayName('minimax'), 'MiniMax Code');
    expect(usageSourceNames.keys, isNot(contains('commandcode')));
    expect(usageSourceNames.keys, isNot(contains('zai')));
    expect(usageSourceNames.keys, isNot(contains('cursor')));
  });

  test('CSV is period-scoped and preserves unknown cells safely', () {
    const range = UsageReportRange(
      from: '2026-09-01',
      to: '2026-09-26',
      recognized: true,
    );
    const tool = UsageReportTool(
      tool: 'custom',
      label: '=malicious,"name"',
      tokens: 123,
      cost: 4,
      coding: false,
    );
    final csv = usageReportCsv([tool], range);
    expect(csv, contains('"2026-09-01","2026-09-26"'));
    expect(csv, contains('"\'=malicious,""name"""'));
    expect(csv, contains('"123.0",,,,,"4.0",'));
  });

  testWidgets(
    'sparse partial buckets stay unavailable and future dates are excluded',
    (tester) async {
      final data =
          jsonDecode(
                File(
                  '../../contracts/generated/usage-report.sample.json',
                ).readAsStringSync(),
              )
              as Map<String, dynamic>;
      data['range'] = {
        'from': '2026-08-01',
        'to': '2026-08-31',
        'recognized': true,
      };
      data['sourceErrors'] = ['offline source'];
      data['daily'] = [
        {'date': '2026-08-01', 'tokens': 12, 'cost': 1, 'requests': 2},
        {'date': '2026-08-03', 'tokens': 999, 'cost': 9, 'requests': 9},
      ];
      await tester.pumpWidget(
        subject(
          UsageActivity(
            period: UsagePeriod.month,
            report: UsageReport.fromJson(data),
            locale: 'en',
            now: DateTime(2026, 8, 2),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final chart = find.byKey(const Key('usage-daily-activity'));
      final tips = tester
          .widgetList<Tooltip>(
            find.descendant(of: chart, matching: find.byType(Tooltip)),
          )
          .toList();
      expect(tips, hasLength(2));
      expect(tips.last.message, contains('No reading in this period'));
      final targets = tester
          .widgetList<InkWell>(
            find.descendant(of: chart, matching: find.byType(InkWell)),
          )
          .toList();
      expect(targets.first.onTap, isNotNull);
      expect(targets.last.onTap, isNull);
      expect(tips.any((tip) => tip.message?.contains('999') ?? false), isFalse);
      final calendar = find.byType(UsageHeatmap);
      final calendarTargets = tester.widgetList<InkWell>(
        find.descendant(of: calendar, matching: find.byType(InkWell)),
      );
      expect(
        calendarTargets.where((target) => target.onTap != null),
        hasLength(1),
      );
      final firstDate = find.descendant(
        of: calendar,
        matching: find.byWidgetPredicate(
          (widget) => widget is Tooltip && widget.message == 'Aug 1, 2026 · 12',
        ),
      );
      await tester.tap(firstDate);
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(find.text('Aug 1, 2026'), findsWidgets);

      expect(tester.takeException(), isNull);
    },
  );
}
