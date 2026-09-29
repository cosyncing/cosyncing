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
import 'package:cosyncing_client/src/features/usage/view/usage_hero.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_when_you_work.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  UsageReport report() => UsageReport.fromJson(
    jsonDecode(
          File(
            '../../contracts/generated/usage-report.sample.json',
          ).readAsStringSync(),
        )
        as Map<String, dynamic>,
  );

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

  UsageReport longReport(int days) {
    final data =
        jsonDecode(
              File(
                '../../contracts/generated/usage-report.sample.json',
              ).readAsStringSync(),
            )
            as Map<String, dynamic>;
    // Calendar buckets are civil dates; local-duration arithmetic would shift
    // January's midnight across the host's daylight-saving boundary.
    final start = DateTime.utc(2026, 9, 27).subtract(Duration(days: days - 1));
    String date(DateTime day) => day.toIso8601String().substring(0, 10);
    data['range'] = {
      'from': date(start),
      'to': '2026-09-27',
      'recognized': true,
    };
    data['daily'] = [
      for (var i = 0; i < days; i++)
        {
          'date': date(start.add(Duration(days: i))),
          'tokens': i + 1,
          'cost': 1,
          'requests': 1,
        },
    ];
    return UsageReport.fromJson(data);
  }

  for (final period in [UsagePeriod.year, UsagePeriod.allTime]) {
    testWidgets('$period fits every desktop day and retains exact detail', (
      tester,
    ) async {
      tester.view
        ..physicalSize = const Size(1440, 1080)
        ..devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final days = period == UsagePeriod.year ? 270 : 730;
      await tester.pumpWidget(
        subject(
          Center(
            child: SizedBox(
              width: 1068,
              child: UsageActivity(
                period: period,
                report: longReport(days),
                locale: 'en',
                now: DateTime(2026, 9, 27),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final chart = find.byKey(const Key('usage-daily-activity'));
      final bars = find.descendant(of: chart, matching: find.byType(Tooltip));
      expect(bars, findsNWidgets(days));
      final viewport = tester.getRect(chart);
      expect(
        tester.getRect(bars.first).left,
        greaterThanOrEqualTo(viewport.left),
      );
      expect(
        tester.getRect(bars.last).right,
        lessThanOrEqualTo(viewport.right + 0.1),
      );
      final lastBar = find
          .descendant(of: bars.last, matching: find.byType(Container))
          .last;
      expect(tester.getSize(lastBar).width, greaterThan(0));
      expect(tester.widget<Tooltip>(bars.last).message, 'Sep 27, 2026 · $days');
      await tester.tap(bars.last);
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.text('Sep 27, 2026'),
        ),
        findsOneWidget,
      );
    });
  }

  testWidgets(
    'phone histogram axis scrolls with its days and opens at recent days',
    (tester) async {
      tester.view
        ..physicalSize = const Size(390, 844)
        ..devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        subject(
          UsageActivity(
            period: UsagePeriod.year,
            report: longReport(270),
            locale: 'en',
            now: DateTime(2026, 9, 27),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final chart = find.byKey(const Key('usage-daily-activity'));
      final bars = find.descendant(of: chart, matching: find.byType(Tooltip));
      final firstLabel = find.descendant(
        of: chart,
        matching: find.text('Jan 1, 2026'),
      );
      final lastLabel = find.descendant(
        of: chart,
        matching: find.text('Sep 27, 2026'),
      );
      final viewport = tester.getRect(chart);
      expect(tester.getRect(bars.last).right, closeTo(viewport.right, 0.1));
      expect(tester.getRect(lastLabel).right, closeTo(viewport.right, 0.1));
      expect(tester.getRect(firstLabel).right, lessThan(viewport.left));
      final oldBarX = tester.getRect(bars.last).right;
      final oldLabelX = tester.getRect(lastLabel).right;
      await tester.drag(chart, const Offset(130, 0));
      await tester.pumpAndSettle();
      final delta = tester.getRect(bars.last).right - oldBarX;
      expect(delta, greaterThan(0));
      expect(tester.getRect(lastLabel).right - oldLabelX, closeTo(delta, 0.1));
      expect(tester.takeException(), isNull);
    },
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
    'day has hourly activity, week has daily bars, neither a calendar',
    (tester) async {
      for (final period in [UsagePeriod.today, UsagePeriod.week]) {
        await tester.pumpWidget(
          subject(
            UsageActivity(
              period: period,
              report: report(),
              locale: 'en',
              now: DateTime(2026, 9, 2),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.byType(UsageHeatmap), findsNothing);
        expect(
          find.byKey(
            Key(
              period == UsagePeriod.today
                  ? 'usage-hourly-activity'
                  : 'usage-daily-activity',
            ),
          ),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      }
    },
  );

  testWidgets('a day drops the streak, the peak day and the weekday bars', (
    tester,
  ) async {
    final served = report();
    // Every day-only omission is checked against the week, which still draws
    // it, so a sample that stopped serving streaks or weekdays fails here
    // instead of passing vacuously.
    for (final period in [UsagePeriod.week, UsagePeriod.today]) {
      final day = period == UsagePeriod.today;
      await tester.pumpWidget(
        subject(
          Column(
            children: [
              UsageHero(period: period, report: served, locale: 'en'),
              UsageActivity(
                period: period,
                report: served,
                locale: 'en',
                now: DateTime(2026, 9, 2),
              ),
              UsageWhenYouWork(
                hourly: served.hourly,
                weekday: served.weekday,
                timezone: served.timezone,
                locale: 'en',
                totalTokens: served.totals.tokens,
                showHourlyChart: !day,
                showWeekday: !day,
              ),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();
      final expected = day ? findsNothing : findsWidgets;
      // The hero's tiles set their labels in capitals.
      expect(find.text('DAY STREAK'), expected, reason: '$period streak tile');
      expect(find.text('PEAK DAY'), expected, reason: '$period peak tile');
      expect(find.text('Peak day'), expected, reason: '$period peak weekday');
      expect(
        find.textContaining('days active'),
        expected,
        reason: '$period streak line',
      );
      expect(find.text('Mon'), expected, reason: '$period weekday bars');
      // What a day does have stays: its peak hour.
      expect(find.text('Peak hour'), findsOneWidget, reason: '$period');
      expect(tester.takeException(), isNull);
    }
  });

  testWidgets(
    'weekday shares use the whole period and missing days stay unknown',
    (tester) async {
      await tester.pumpWidget(
        subject(
          const UsageWhenYouWork(
            hourly: null,
            weekday: UsageReportWeekday(
              buckets: [
                UsageReportWeekdayBucket(
                  weekday: 0,
                  tokens: 10,
                  cost: 1,
                  requests: 1,
                ),
              ],
            ),
            timezone: 'UTC',
            locale: 'en',
            totalTokens: 1000,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('10 · 1.0%'), findsOneWidget);
      expect(find.text('—'), findsNWidgets(6));
      expect(tester.takeException(), isNull);
    },
  );

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

  testWidgets('all eight sortable columns survive at phone width', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(320, 900);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      subject(UsageAgentTable(tools: report().tools, locale: 'en')),
    );
    await tester.pumpAndSettle();
    final table = tester.widget<DataTable>(find.byType(DataTable));
    expect(table.columns, hasLength(8));
    expect(table.columns.every((column) => column.onSort != null), isTrue);
    expect(find.byKey(const Key('usage-agent-table-scroll')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
