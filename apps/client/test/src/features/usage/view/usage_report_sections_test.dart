import 'dart:convert';
import 'dart:io';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_export_service.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_report_api.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_heatmap.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_report_page.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_when_you_work.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, dynamic> sampleReport() =>
    jsonDecode(
          File(
            '../../contracts/generated/usage-report.sample.json',
          ).readAsStringSync(),
        )
        as Map<String, dynamic>;

class _StubApi implements UsageReportApi {
  _StubApi(this.response);

  final UsageReportResponse? response;

  @override
  Future<UsageReportResponse> getReport({
    required String from,
    required String to,
  }) async {
    final response = this.response;
    if (response == null) {
      throw const BrokerException(message: 'unavailable', statusCode: 502);
    }
    return response;
  }
}

void main() {
  final now = DateTime(2026, 9, 2, 9);

  UsageReportResponse served(Map<String, dynamic> data) =>
      UsageReportResponse.fromJson({'ok': true, 'data': data});

  Widget buildSubject({
    required Map<String, dynamic> data,
    Locale locale = const Locale('en'),
    Size size = const Size(1000, 2400),
  }) {
    final spec = themeSpecById(kDefaultThemeId);
    return ProviderScope(
      overrides: [
        usageNowProvider.overrideWithValue(() => now),
        usageReportApiProvider.overrideWithValue(_StubApi(served(data))),
        // flutter_test reports Android, where the share section is a notice.
        // Pinned so the export controls are actually in the tree to assert on.
        usageExportSupportedProvider.overrideWithValue(true),
        usageExportCaptureProvider.overrideWithValue((key) async => null),
      ],
      child: MaterialApp(
        locale: locale,
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: buildAppTheme(spec.light, Brightness.light),
        home: MediaQuery(
          data: MediaQueryData(size: size),
          child: const UsageReportPage(),
        ),
      ),
    );
  }

  group('hero', () {
    testWidgets('three numbers and one sentence carrying every claim', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(data: sampleReport()));
      await tester.pumpAndSettle();

      final hero = find.byKey(const Key('usage-report-hero'));
      expect(hero, findsOneWidget);
      for (final figure in ['19.9B', '786.2h', '31']) {
        expect(
          find.descendant(of: hero, matching: find.text(figure)),
          findsOneWidget,
        );
      }

      final sentence = tester.widget<Text>(
        find.byKey(const Key('usage-report-hero-sentence')),
      );
      // Sessions, tokens, the qualified cost, the served delta, and the window
      // it is measured against — all of them served, none of them rounded into
      // a different claim.
      expect(sentence.data, contains('294 sessions'));
      expect(sentence.data, contains('19.9B tokens'));
      expect(sentence.data, contains('at API list prices — not your bill'));
      expect(sentence.data, contains('15.5% more'));
      expect(sentence.data, contains('than July'));
    });

    testWidgets('no served comparison drops the clause, never zeroes it', (
      tester,
    ) async {
      final data = sampleReport()..remove('comparison');
      await tester.pumpWidget(buildSubject(data: data));
      await tester.pumpAndSettle();

      final sentence = tester.widget<Text>(
        find.byKey(const Key('usage-report-hero-sentence')),
      );
      expect(sentence.data, isNot(contains('more')));
      expect(sentence.data, isNot(contains('0%')));
      expect(sentence.data, contains('19.9B tokens'));
    });
  });

  group('active days', () {
    testWidgets('the heatmap renders with its legend and streak evidence', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(data: sampleReport()));
      await tester.pumpAndSettle();

      final days = find.byKey(const Key('usage-report-active-days'));
      expect(days, findsOneWidget);
      expect(
        find.descendant(of: days, matching: find.text('Less')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: days, matching: find.text('More')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: days,
          matching: find.textContaining('busiest day Aug 31'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('no daily facet means no heatmap, not an empty grid', (
      tester,
    ) async {
      final data = sampleReport()..remove('daily');
      await tester.pumpWidget(buildSubject(data: data));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('usage-report-active-days')), findsNothing);
      // The rest of the report still renders: one absent facet is not an
      // absent report.
      expect(find.byKey(const Key('usage-report-hero')), findsOneWidget);
    });
  });

  group('podium', () {
    testWidgets('three leaders, each with its share of the period', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(data: sampleReport()));
      await tester.pumpAndSettle();

      final podium = find.byKey(const Key('usage-report-podium'));
      expect(podium, findsOneWidget);
      for (final name in ['Claude Code', 'claude-opus-5', 'atlas']) {
        expect(
          find.descendant(of: podium, matching: find.text(name)),
          findsOneWidget,
        );
      }
      expect(
        find.descendant(
          of: podium,
          matching: find.textContaining('10.1B · 51%'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('the project tile reconciles against the period total', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(data: sampleReport()));
      await tester.pumpAndSettle();

      // Without this line a 39% leader reads as 39% of everything, which is a
      // share of the facet, not of the period.
      final podium = find.byKey(const Key('usage-report-podium'));
      expect(
        find.descendant(
          of: podium,
          matching: find.textContaining(
            'from sources with no project records',
          ),
        ),
        findsOneWidget,
      );
      // The fragmentation is stated rather than merged away: merging two
      // remotes of one codebase would invent a total nobody served.
      expect(
        find.descendant(
          of: podium,
          matching: find.textContaining(
            'Projects are grouped by repository remote',
          ),
        ),
        findsOneWidget,
      );
    });
  });

  group('when you work', () {
    testWidgets('peak hour, night window and peak day are all served', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(data: sampleReport()));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('usage-report-when')), findsOneWidget);
      expect(find.text('15:00 – 16:00'), findsOneWidget);
      expect(find.text('21.8%'), findsOneWidget);
      // The night window comes from the facet. Hardcoding 22–02 would make the
      // index a claim about the reader rather than a reading of their data.
      expect(
        find.textContaining('share of tokens, 22:00 – 02:00'),
        findsOneWidget,
      );
      expect(find.text('Sun'), findsWidgets);
    });

    testWidgets('absent facets collapse to a notice, not an empty chart', (
      tester,
    ) async {
      final data = sampleReport()
        ..remove('hourly')
        ..remove('weekday');
      await tester.pumpWidget(buildSubject(data: data));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('usage-report-when')), findsOneWidget);
      expect(
        find.textContaining('Hour-of-day data unavailable'),
        findsOneWidget,
      );
      // Everything else still renders.
      expect(find.byKey(const Key('usage-report-podium')), findsOneWidget);
    });

    test('the night window is read off the served hours, wrap included', () {
      expect(
        usageNightWindowLabel(const [22, 23, 0, 1], 'en'),
        '22:00 – 02:00',
      );
      expect(usageNightWindowLabel(const [1, 2, 3], 'en'), '01:00 – 04:00');
      // No served window means no label, so the note is suppressed rather than
      // filled with a plausible default.
      expect(usageNightWindowLabel(const [], 'en'), '');
    });
  });

  group('by agent', () {
    testWidgets('coding apps are rows; everything else folds into one', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(data: sampleReport()));
      await tester.pumpAndSettle();

      final agents = find.byKey(const Key('usage-report-agents'));
      expect(agents, findsOneWidget);
      expect(
        find.descendant(
          of: agents,
          matching: find.text('Cost · API list price'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(of: agents, matching: find.text('openclaw')),
        findsNothing,
      );

      final toggle = find.byKey(const Key('usage-report-other-tools'));
      await tester.ensureVisible(toggle);
      await tester.pumpAndSettle();
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      expect(
        find.descendant(of: agents, matching: find.text('openclaw')),
        findsOneWidget,
      );
    });

    testWidgets('a cell the API never served is a dash, never a zero', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(data: sampleReport()));
      await tester.pumpAndSettle();

      final toggle = find.byKey(const Key('usage-report-other-tools'));
      await tester.ensureVisible(toggle);
      await tester.pumpAndSettle();
      await tester.tap(toggle);
      await tester.pumpAndSettle();
      // openclaw has no sessions and no active time in the served rows.
      expect(
        find.descendant(
          of: find.byKey(const Key('usage-report-agents')),
          matching: find.text('—'),
        ),
        findsWidgets,
      );
    });
  });

  group('footer', () {
    testWidgets('carries every caveat the figures above depend on', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(data: sampleReport()));
      await tester.pumpAndSettle();

      expect(find.textContaining('local midnight'), findsOneWidget);
      expect(find.textContaining('not billed spend'), findsOneWidget);
      expect(find.textContaining('idle gaps over 5 minutes'), findsOneWidget);
      expect(find.textContaining('5 tool sources'), findsOneWidget);
    });
  });

  group('year', () {
    /// A full year-to-date window, expanded from the committed sample.
    ///
    /// The design mocked Month end-to-end and called the other periods "a
    /// rendering exercise", but 年度报告 is the headline: 244 day cells across
    /// 36 week columns is the case where the heatmap, the podium heading and
    /// the hero sentence all have to hold a shape the month view never
    /// exercises.
    Map<String, dynamic> yearReport() {
      final data = sampleReport();
      data['range'] = {
        'from': '2026-01-01',
        'to': '2026-09-01',
        'days': 244,
        'recognized': true,
        'periodResolved': 'custom',
      };
      final start = DateTime.utc(2026);
      data['daily'] = [
        for (var offset = 0; offset < 244; offset++)
          if (offset % 8 != 3)
            {
              'date': start
                  .add(Duration(days: offset))
                  .toIso8601String()
                  .substring(0, 10),
              'tokens': 100000000 + offset * 1000000,
              'cost': 60.0,
              'requests': 500,
              'intensity': (offset % 4) + 1,
            },
      ];
      data['streaks'] = {
        'currentStreak': 171,
        'longestStreak': 171,
        'activeDays': 214,
        'totalDays': 244,
      };
      data['firsts'] = {
        'firstActiveDay': '2026-01-01',
        'lastActiveDay': '2026-09-01',
        'busiestDay': '2026-09-01',
        'busiestDayTokens': 1614464700,
      };
      data['comparison'] = {
        'tokensPrev': 15000000000,
        'tokensPct': 32.6,
      };
      return data;
    }

    testWidgets('a 244-day window renders every section', (tester) async {
      await tester.pumpWidget(buildSubject(data: yearReport()));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Year'));
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      expect(find.byKey(const Key('usage-report-hero')), findsOneWidget);
      expect(find.byKey(const Key('usage-report-active-days')), findsOneWidget);
      expect(find.byKey(const Key('usage-report-podium')), findsOneWidget);
      expect(find.byKey(const Key('usage-report-when')), findsOneWidget);
      expect(find.byKey(const Key('usage-report-agents')), findsOneWidget);

      // The period owns its heading and its explicit window; a year must not
      // borrow the month's.
      expect(find.text('Top of the year'), findsOneWidget);
      expect(find.text('2026-01-01 – 2026-09-01'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(const Key('usage-report-active-days')),
          matching: find.textContaining('214 of 244 days active'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('the year sentence compares against the year before', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(data: yearReport()));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Year'));
      await tester.pumpAndSettle();

      final sentence = tester.widget<Text>(
        find.byKey(const Key('usage-report-hero-sentence')),
      );
      expect(sentence.data, contains('In 2026'));
      expect(sentence.data, contains('than 2025'));
      // Sessions were counted, not estimated: 2.5K would read as a rounding
      // of something exact.
      expect(sentence.data, contains('294 sessions'));
    });

    testWidgets('a first year has nothing to compare against, and says so', (
      tester,
    ) async {
      // This machine's real 2026 window serves tokensPct = 1231088.3, because
      // the 244 days before it are mostly before the record begins. The figure
      // is served and arithmetically true; as a sentence it is about nothing.
      final data = yearReport();
      data['comparison'] = {
        'tokensPrev': 4676830,
        'tokensPct': 1231088.3,
      };
      await tester.pumpWidget(buildSubject(data: data));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Year'));
      await tester.pumpAndSettle();

      final sentence = tester.widget<Text>(
        find.byKey(const Key('usage-report-hero-sentence')),
      );
      expect(sentence.data, isNot(contains('%')));
      expect(sentence.data, isNot(contains('than 2025')));
      // Everything it can say, it still says.
      expect(sentence.data, contains('In 2026'));
      expect(sentence.data, contains('19.9B tokens'));
    });

    testWidgets('an empty prior window drops the clause too', (tester) async {
      final data = yearReport();
      data['comparison'] = {'tokensPrev': 0, 'tokensPct': 0};
      await tester.pumpWidget(buildSubject(data: data));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Year'));
      await tester.pumpAndSettle();

      final sentence = tester.widget<Text>(
        find.byKey(const Key('usage-report-hero-sentence')),
      );
      // A served pct of 0 against an empty window is not "no change".
      expect(sentence.data, isNot(contains('0% more')));
      expect(sentence.data, isNot(contains('than 2025')));
    });

    testWidgets('a week has no nameable predecessor, so it drops the clause', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(data: sampleReport()));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Week'));
      await tester.pumpAndSettle();

      final sentence = tester.widget<Text>(
        find.byKey(const Key('usage-report-hero-sentence')),
      );
      // Rather than inventing "than the previous week", which is a phrase and
      // not a window the reader could check.
      expect(sentence.data, isNot(contains('than')));
      expect(sentence.data, contains('19.9B tokens'));
    });
  });

  testWidgets('the whole report renders in Chinese', (tester) async {
    await tester.pumpWidget(
      buildSubject(data: sampleReport(), locale: const Locale('zh')),
    );
    await tester.pumpAndSettle();

    expect(
      find.descendant(
        of: find.byKey(const Key('usage-report-hero')),
        matching: find.text('19.9B'),
      ),
      findsOneWidget,
    );
    expect(find.text('你的时间分布'), findsOneWidget);
    expect(find.text('本月之最'), findsOneWidget);
    expect(find.text('按 agent'), findsOneWidget);
  });

  group('withheld project names', () {
    Map<String, dynamic> withheld() {
      // Exactly what a non-owner is served: the facet gone, the reason said.
      final data = sampleReport()
        ..remove('projects')
        ..['projectsUnavailable'] = 'owner-only';
      return data;
    }

    testWidgets('the podium says the names were withheld, not absent', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(data: withheld()));
      await tester.pumpAndSettle();

      expect(
        find.textContaining('Project names are served to the broker owner'),
        findsOneWidget,
      );
      // The counts are untouched, so the rest of the page still stands.
      expect(
        find.descendant(
          of: find.byKey(const Key('usage-report-hero')),
          matching: find.text('19.9B'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('no project name reaches the tree', (tester) async {
      await tester.pumpWidget(buildSubject(data: withheld()));
      await tester.pumpAndSettle();

      final names =
          (sampleReport()['projects']! as Map<String, dynamic>)['rows']!
              as List<dynamic>;
      expect(names, isNotEmpty);
      for (final row in names) {
        final project = (row as Map<String, dynamic>)['project']! as String;
        expect(
          find.textContaining(project),
          findsNothing,
          reason: 'withheld report still rendered $project',
        );
      }
    });

    testWidgets('the project-detail export is not offered', (tester) async {
      await tester.pumpWidget(buildSubject(data: withheld()));
      await tester.pumpAndSettle();

      // A card whose whole content is project names has nothing to carry —
      // while the counts-only card, which never had names, still does.
      expect(find.byKey(const Key('usage-export-overview')), findsOneWidget);
      expect(find.byKey(const Key('usage-export-projectDetail')), findsNothing);
    });

    testWidgets('both exports are offered when the names are served', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(data: sampleReport()));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('usage-export-overview')), findsOneWidget);
      expect(
        find.byKey(const Key('usage-export-projectDetail')),
        findsOneWidget,
      );
    });
  });

  group('the activity grid', () {
    Map<String, dynamic> allTime() {
      // The shape a live all-time window actually returns: tokdash echoes the
      // requested floor and counts every day in it, while serving rows only for
      // the days it has.
      final data = sampleReport();
      (data['range']! as Map<String, dynamic>)
        ..['from'] = '2000-01-01'
        ..['to'] = '2026-09-01'
        ..['days'] = 9742;
      data['firsts'] = {'firstActiveDay': '2025-11-19'};
      return data;
    }

    test(
      'the grid starts at the first served day, not the requested floor',
      () {
        final report = UsageReportResponse.fromJson({
          'ok': true,
          'data': allTime(),
        }).report!;
        final requested = DateTime.parse('2000-01-01');

        final start = usageHeatmapStart(requested, report);
        expect(start.isAfter(requested), isTrue);
        // Drawn from 2000 this is ~1,392 non-lazy week columns, 97% of them
        // holes, and a quarter century of empty weeks before the data.
        final weeks = DateTime.parse('2026-09-01').difference(start).inDays / 7;
        expect(weeks, lessThan(60));
      },
    );

    test('a window with no rows keeps the window it asked for', () {
      final data = allTime()
        ..remove('daily')
        ..remove('firsts');
      final report = UsageReportResponse.fromJson({
        'ok': true,
        'data': data,
      }).report!;
      final requested = DateTime.parse('2000-01-01');

      // Nothing served is not evidence about when work started, so the grid
      // stays the window rather than collapsing to a day.
      expect(usageHeatmapStart(requested, report), requested);
    });

    test('a served day before the window does not drag the grid back', () {
      final report = UsageReportResponse.fromJson({
        'ok': true,
        'data': sampleReport(),
      }).report!;
      final requested = DateTime.parse('2026-08-15');

      // The month windows already start after their first served row; the grid
      // must never reach outside the window the report covers.
      expect(usageHeatmapStart(requested, report), requested);
    });

    testWidgets('an all-time window renders a grid the reader can reach', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(data: allTime()));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('usage-report-active-days')),
        findsOneWidget,
      );
      // The grid scrolls horizontally, so its own box is the viewport and says
      // nothing about how much was built. The week Row inside the scroll view
      // is the intrinsic extent, and that is what the reader has to scroll.
      final weekRow = find
          .descendant(
            of: find.descendant(
              of: find.byKey(const Key('usage-report-active-days')),
              matching: find.byType(UsageHeatmap),
            ),
            matching: find.byType(Row),
          )
          .first;
      // Untrimmed this is ~1,392 week columns and roughly 10,000px.
      expect(tester.getSize(weekRow).width, lessThan(2000));
    });
  });
}
