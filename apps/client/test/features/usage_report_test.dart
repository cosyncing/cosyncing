// F10 — The usage report and its export, through the real App.
//
// Journeys, each one launch with several assertions along the way:
//   1. report: one served month read in full, then every other window the user
//      can step to, each answered with a different shape of report (partial,
//      empty, unrecognized, old Tokdash, names withheld, facets missing), then
//      the other periods, and the report in another language.
//   2. export: the share section saves what it promises, per platform.
//
// Time is pinned (`usageNowProvider`): 2026-09-02, a Wednesday.
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';
import 'package:cosyncing_client/src/features/settings/controller/theme_controller.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_export_service.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_report_api.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_agent_logo.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_export_card.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_heatmap.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:share_plus/share_plus.dart';

import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/settings_driver.dart';
import '../support/feature/usage_wire.dart';

final AppLocalizations en = lookupAppLocalizations(const Locale('en'));

Map<String, Object?> part(Map<String, Object?> report, String key) =>
    (report[key]! as Map).cast<String, Object?>();

/// A full year-to-date window, expanded from the committed sample: 244 day
/// cells across 36 week columns, the shape the month view never exercises.
Map<String, Object?> yearReport() {
  final data = usageSample();
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
  data['comparison'] = {'tokensPrev': 15000000000, 'tokensPct': 32.6};
  return data;
}

/// A window of [days] days ending today, a day row for each.
Map<String, Object?> longWindow(String from, int days) {
  final data = usageSample();
  final start = DateTime.utc(2026, 9, 2).subtract(Duration(days: days - 1));
  String date(DateTime day) => day.toIso8601String().substring(0, 10);
  data['range'] = {'from': from, 'to': '2026-09-02', 'recognized': true};
  data['daily'] = [
    for (var i = 0; i < days; i++)
      {
        'date': date(start.add(Duration(days: i))),
        'tokens': i + 1,
        'cost': 2,
        'requests': 1,
      },
  ];
  return data;
}

/// A bounded month whose first activity is late in it: the report covered every
/// day from the 1st and the user simply did nothing until [firstRow].
Map<String, Object?> lateMonth(String firstRow) {
  final data = usageSample();
  part(data, 'range')
    ..['from'] = '2025-11-01'
    ..['to'] = '2025-11-30'
    ..['days'] = 30;
  data['daily'] = [
    {
      'date': firstRow,
      'tokens': 1000,
      'cost': 1.0,
      'requests': 10,
      'intensity': 2,
    },
  ];
  data['firsts'] = {'firstActiveDay': firstRow};
  return data;
}

void main() {
  setUpAll(() async {
    // The real faces: the test font is wider than any the app ships, so a
    // layout check on it reports overflows no user would ever see.
    TestWidgetsFlutterBinding.ensureInitialized();
    final font = FontLoader('Lato')
      ..addFont(rootBundle.load('assets/fonts/Lato-Regular.ttf'))
      ..addFont(rootBundle.load('assets/fonts/Lato-Semibold.ttf'))
      ..addFont(rootBundle.load('assets/fonts/Lato-Bold.ttf'));
    await font.load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });

  featureTest('a usage report is read, stepped through and varied', (f) async {
    final studio = f.network.add('http://studio.test:7734');
    await f.storage.seedServer(studio);
    final desk = UsageDesk(studio);
    final app = await f.launch(
      viewport: FeatureViewport.desktopTall,
      initialLocation: '$usageReportRoute?period=year',
      overrides: [
        usageNowProvider.overrideWithValue(() => DateTime(2026, 9, 2, 9)),
      ],
    );
    final hero = find.byKey(const Key('usage-report-hero'));
    Finder inHero(String text) =>
        find.descendant(of: hero, matching: find.text(text));
    Finder key(String k) => find.byKey(Key(k));
    String range() => app.tester.widget<Text>(key('usage-report-range')).data!;
    bool enabled(String k) =>
        app.tester.widget<IconButton>(key(k)).onPressed != null;

    // A link names the period it means.
    expect(
      find.descendant(
        of: key('usage-period-switcher'),
        matching: find.text(en.usagePeriodYear),
      ),
      findsOneWidget,
    );
    expect(desk.windows.single, (from: '2026-01-01', to: '2026-09-02'));

    // An unknown link name opens nothing of its own: the month in progress,
    // and the sections below the fold arrive after the page.
    await app.go(generalSettingsRoute);
    desk.windows.clear();
    app.router.go('$usageReportRoute?period=fortnight');
    for (var frame = 0; frame < 40 && hero.evaluate().isEmpty; frame++) {
      await app.tester.pump(const Duration(milliseconds: 20));
    }
    expect(hero, findsOneWidget);
    expect(key('usage-report-agents'), findsNothing);
    expect(key('usage-report-share'), findsNothing);
    await app.settle();
    expect(key('usage-report-agents'), findsOneWidget);
    expect(key('usage-report-share'), findsOneWidget);
    expect(desk.windows.single, (from: '2026-09-01', to: '2026-09-02'));

    // --- one served month, read in full -------------------------------------
    expect(
      app.tester.widget<Text>(key('usage-report-title')).data,
      en.usageReportTitle('August 2026'),
    );
    expect(range(), contains('2026-08-01 – 2026-08-31'));
    for (final label in [
      'TOKENS',
      'COST',
      'MESSAGES',
      'SESSIONS',
      'EST. AGENT TIME',
      'CACHE HIT RATE',
      'DAY STREAK',
      'PEAK WEEK',
    ]) {
      expect(inHero(label), findsOneWidget, reason: label);
    }
    for (final figure in [
      '19.9B',
      r'$12,977',
      '129K',
      '294',
      '1 month 2 days',
    ]) {
      expect(inHero(figure), findsOneWidget, reason: figure);
    }
    // Cost is a bare figure; every tile is as tall as its row.
    expect(
      find.ancestor(of: inHero(r'$12,977'), matching: find.byType(Tooltip)),
      findsNothing,
    );
    for (final text in [
      'list price',
      'list-price',
      'not your bill',
      'billed spend',
      'local midnight',
      'Active time excludes idle gaps',
      'tool sources',
    ]) {
      expect(find.textContaining(text), findsNothing, reason: text);
    }
    final tileHeights = {
      for (final label in ['TOKENS', 'COST', 'DAY STREAK', 'PEAK WEEK'])
        app.tester
            .getSize(
              find
                  .ancestor(of: inHero(label), matching: find.byType(Padding))
                  .first,
            )
            .height,
    };
    expect(tileHeights, hasLength(1));
    // The agent-time rule rides a tooltip, not a footer.
    expect(
      app.tester
          .widgetList<Tooltip>(
            find.descendant(of: hero, matching: find.byType(Tooltip)),
          )
          .map((tooltip) => tooltip.message),
      contains(contains('idle gaps over 5 minutes')),
    );
    // Active days: a heatmap with legend and streak evidence.
    final days = key('usage-report-active-days');
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
    expect(key('usage-daily-activity'), findsOneWidget);
    // Podium: three leaders with their top rows, no footnotes.
    final podium = key('usage-report-podium');
    for (final name in [
      'Claude Code',
      'Codex',
      'OpenClaw',
      'claude-opus-5',
      'gpt-5.6-sol',
      'atlas',
      'atlas_private',
    ]) {
      expect(
        find.descendant(of: podium, matching: find.text(name)),
        findsOneWidget,
        reason: name,
      );
    }
    expect(
      find.descendant(of: podium, matching: find.textContaining('10.1B · 51%')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: podium, matching: find.byType(UsageAgentLogo)),
      findsNWidgets(3),
    );
    for (final note in [
      'ranked by tokens',
      'from sources with no project records',
      'Projects are grouped by repository remote',
    ]) {
      expect(
        find.descendant(of: podium, matching: find.textContaining(note)),
        findsNothing,
        reason: note,
      );
    }
    // When you work: peak hour, the night window read off the served hours.
    expect(find.text('15:00 – 16:00'), findsOneWidget);
    expect(find.text('21.8%'), findsOneWidget);
    expect(
      find.textContaining('share of tokens, 22:00 – 02:00'),
      findsOneWidget,
    );
    expect(find.text('Sun'), findsWidgets);
    // By agent: every tool is a row, and a cell never served is a dash.
    final agents = key('usage-report-agents');
    expect(
      find.descendant(of: agents, matching: find.text('OpenClaw')),
      findsOneWidget,
    );
    expect(find.descendant(of: agents, matching: find.text('—')), findsWidgets);
    expect(key('usage-report-other-tools'), findsNothing);
    // Every hero tile is as tall as its row, subline or not.
    final heights = <double>{
      for (final label in ['TOKENS', 'COST', 'DAY STREAK', 'PEAK WEEK'])
        app.tester
            .getSize(
              find
                  .ancestor(
                    of: find.descendant(
                      of: hero,
                      matching: find.text(label),
                    ),
                    matching: find.byType(Padding),
                  )
                  .first,
            )
            .height,
    };
    expect(heights, hasLength(1), reason: 'tile heights: $heights');
    // The harness mark sits on the name's x-height, 15 px wide and 19 px in,
    // on the podium and in the agent table alike.
    for (final section in ['usage-report-podium', 'usage-report-agents']) {
      final name = find
          .descendant(of: key(section), matching: find.text('Claude Code'))
          .first;
      final mark = find
          .descendant(of: key(section), matching: find.byType(UsageAgentLogo))
          .first;
      final nameRect = app.tester.getRect(name);
      final markRect = app.tester.getRect(mark);
      expect(markRect.size, const Size.square(usageAgentNameMarkSize));
      expect(
        nameRect.left - markRect.left,
        closeTo(usageAgentNameMarkOffset, 0.01),
        reason: section,
      );
      final dy = UsageAgentNameMark.xHeightOffset(
        app.tester.widget<Text>(name).style!,
        MediaQuery.textScalerOf(app.tester.element(name)),
      );
      expect(
        markRect.center.dy,
        closeTo(nameRect.top + nameRect.height / 2 + dy, 0.5),
        reason: section,
      );
    }
    // Both exports are offered when the names are served; no prompt text.
    expect(key('usage-export-overview'), findsOneWidget);
    expect(key('usage-export-projectDetail'), findsOneWidget);
    for (final text in app.tester.widgetList<Text>(find.byType(Text))) {
      expect(text.data ?? '', isNot(contains('display_name')));
    }

    // --- stepping back through complete periods -----------------------------
    // Previous is open and next is shut on the period in progress; the buttons
    // name where they go.
    expect(enabled('usage-period-previous'), isTrue);
    expect(enabled('usage-period-next'), isFalse);
    expect(
      app.tester.widget<IconButton>(key('usage-period-previous')).tooltip,
      en.usagePeriodPrevious('month'),
    );
    expect(
      app.tester.widget<IconButton>(key('usage-period-next')).tooltip,
      en.usagePeriodNext('month'),
    );
    final served = <String, Map<String, Object?> Function()>{
      // 1 back: a read that could not include two tools.
      '2026-08-01': () => usageSample()..['sourceErrors'] = ['kimi', 'grok'],
      // 2 back: nothing recorded.
      '2026-07-01': () =>
          usageSample()..['totals'] = {'tokens': 0, 'cost': 0, 'requests': 0},
      // 3 back: a window the tokdash did not resolve.
      '2026-06-01': () => usageSample()
        ..['range'] = {
          ...part(usageSample(), 'range'),
          'recognized': false,
        },
      // 4 back: an old tokdash, which also never said `recognized`.
      '2026-05-01': () => usageSample()
        ..['runtime'] = {
          'version': '2.0.0',
          'minimumVersion': '2.5.0',
          'belowMinimum': true,
        }
        ..['range'] = {...part(usageSample(), 'range'), 'recognized': false},
      // 5 back: a broker too old to check claims no upgrade.
      '2026-04-01': () => usageSample()..remove('runtime'),
      // 6 back: exactly what a non-owner is served.
      '2026-03-01': () => usageSample()
        ..remove('projects')
        ..['projectsUnavailable'] = 'owner-only',
      // 7 back: no daily facet.
      '2026-02-01': () => usageSample()..remove('daily'),
      // 8 back: no hour-of-day or weekday facets.
      '2026-01-01': () => usageSample()
        ..remove('hourly')
        ..remove('weekday'),
      // 9 back: the month still in progress at the broker's close of window.
      '2025-12-01': () {
        final data = usageSample();
        part(data, 'range')
          ..['from'] = '2026-08-01'
          ..['to'] = '2026-08-15'
          ..['days'] = 31;
        return data;
      },
      '2025-11-01': () => lateMonth('2025-11-03'),
      '2025-10-01': () => lateMonth('2025-11-19'),
    };
    desk.serve = (window) => (served[window.from] ?? usageSample)();
    Future<void> back() async {
      await app.tester.tap(key('usage-period-previous'));
      await app.settle();
    }

    await back();
    expect(desk.windows.last, (from: '2026-08-01', to: '2026-08-31'));
    expect(range(), isNot(contains('in progress')));
    expect(enabled('usage-period-next'), isTrue);
    // A short total is still a total: it renders beside the warning.
    expect(find.textContaining('kimi, grok'), findsOneWidget);
    expect(hero, findsOneWidget);

    await back();
    expect(find.textContaining('No activity recorded'), findsOneWidget);
    expect(find.text(en.usageUnavailable), findsNothing);

    await back();
    expect(
      find.textContaining('tokdash did not recognize this period'),
      findsOneWidget,
    );
    expect(find.text(en.usageUnavailable), findsNothing);
    expect(hero, findsNothing);
    expect(find.textContaining('19.9B'), findsNothing);

    await back();
    expect(find.textContaining('tokdash 2.0.0'), findsOneWidget);
    expect(find.textContaining('2.5.0 or later'), findsOneWidget);
    expect(find.textContaining('pipx upgrade tokdash'), findsOneWidget);
    expect(
      find.textContaining('tokdash did not recognize this period'),
      findsNothing,
    );
    expect(
      find.byWidgetPredicate(
        (widget) =>
            widget is SelectableText &&
            (widget.data?.contains('pipx upgrade tokdash') ?? false),
      ),
      findsOneWidget,
    );

    await back();
    expect(find.textContaining('pipx upgrade tokdash'), findsNothing);
    expect(hero, findsOneWidget);

    await back();
    expect(
      find.textContaining('Project names are served to the broker owner'),
      findsOneWidget,
    );
    expect(inHero('19.9B'), findsOneWidget);
    for (final project in ['atlas', 'atlas_private']) {
      expect(find.textContaining(project), findsNothing, reason: project);
    }
    expect(key('usage-export-overview'), findsOneWidget);
    expect(key('usage-export-projectDetail'), findsNothing);
    expect(key('usage-export-all'), findsNothing);

    await back();
    expect(find.byType(UsageHeatmap), findsNothing);
    expect(hero, findsOneWidget);

    await back();
    expect(key('usage-report-when'), findsOneWidget);
    expect(find.textContaining('Hour-of-day data unavailable'), findsOneWidget);
    expect(key('usage-report-podium'), findsOneWidget);

    await back();
    expect(
      app.tester
          .widget<UsageHeatmap>(
            find.descendant(
              of: key('usage-report-active-days'),
              matching: find.byType(UsageHeatmap),
            ),
          )
          .to,
      DateTime(2026, 8, 31),
    );

    // A month draws every day it covered, idle ones included: the grid does
    // not move with the first active day.
    double gridWidth() => app.tester
        .getSize(
          find
              .descendant(
                of: find.descendant(
                  of: key('usage-report-active-days'),
                  matching: find.byType(UsageHeatmap),
                ),
                matching: find.byType(Row),
              )
              .first,
        )
        .width;
    await back();
    final early = gridWidth();
    await back();
    expect(gridWidth(), early);
    expect(desk.windows.last, (from: '2025-10-01', to: '2025-10-31'));

    // A read the broker failed is unavailable, never zeros.
    desk.failure = FakeBrokerResponse.error(
      502,
      'TOKDASH_UNAVAILABLE',
      'tokdash is not reachable',
    );
    await back();
    expect(find.text(en.usageUnavailable), findsOneWidget);
    expect(hero, findsNothing);
    expect(find.text('0'), findsNothing);
    desk.failure = null;

    // The way forward reopens, and each window is its own request.
    await app.tester.tap(key('usage-period-current'));
    await app.settle();
    expect(desk.windows.last, (from: '2026-09-01', to: '2026-09-02'));
    expect(enabled('usage-period-next'), isFalse);
    expect(hero, findsOneWidget);
  });

  featureTest('every period draws its own window and fits it', (f) async {
    final studio = f.network.add('http://studio.test:7734');
    await f.storage.seedServer(studio);
    final desk = UsageDesk(studio);
    final app = await f.launch(
      viewport: FeatureViewport.desktopTall,
      initialLocation: usageReportRoute,
      overrides: [
        usageNowProvider.overrideWithValue(() => DateTime(2026, 9, 2, 9)),
      ],
    );
    Finder key(String k) => find.byKey(Key(k));
    final chart = key('usage-daily-activity');
    Finder bars() => find.descendant(of: chart, matching: find.byType(Tooltip));
    Future<void> period(String label) async {
      await app.tester.tap(
        find.descendant(
          of: key('usage-period-switcher'),
          matching: find.text(label),
        ),
      );
      await app.settle();
    }

    // Year: 244 day cells across the width, every day a bar, exact detail.
    desk.serve = (window) => switch (window.from) {
      '2026-01-01' => yearReport(),
      '2000-01-01' => longWindow(window.from, 400),
      _ => usageSample(),
    };
    await period('Year');
    expect(desk.windows.last, (from: '2026-01-01', to: '2026-09-02'));
    for (final k in [
      'usage-report-hero',
      'usage-report-active-days',
      'usage-report-podium',
      'usage-report-when',
      'usage-report-agents',
    ]) {
      expect(key(k), findsOneWidget, reason: k);
    }
    expect(find.text('Top of the year'), findsOneWidget);
    expect(find.text('PEAK MONTH'), findsOneWidget);
    expect(
      app.tester.widget<Text>(key('usage-report-range')).data,
      contains('2026-01-01 – 2026-09-01'),
    );
    expect(
      find.descendant(
        of: key('usage-report-active-days'),
        matching: find.textContaining('214 of 244 days active'),
      ),
      findsOneWidget,
    );
    expect(chart, findsOneWidget);
    expect(find.byKey(const Key('usage-report-hero-sentence')), findsNothing);
    expect(app.tester.takeException(), isNull);

    // All time: the grid starts at the first served day, not at the floor, and
    // there is no window to step into.
    await period('All time');
    expect(desk.windows.last.from, '2000-01-01');
    final viewport = app.tester.getRect(chart);
    expect(bars(), findsNWidgets(400));
    expect(
      app.tester.getRect(bars().first).left,
      greaterThanOrEqualTo(viewport.left),
    );
    expect(
      app.tester.getRect(bars().last).right,
      lessThanOrEqualTo(viewport.right + 0.1),
    );
    expect(
      (bars().evaluate().last.widget as Tooltip).message,
      'Sep 2, 2026 · 400',
    );
    final weekRow = find
        .descendant(
          of: find.descendant(
            of: key('usage-report-active-days'),
            matching: find.byType(UsageHeatmap),
          ),
          matching: find.byType(Row),
        )
        .first;
    expect(app.tester.getSize(weekRow).width, lessThan(2000));
    for (final k in ['usage-period-previous', 'usage-period-next']) {
      expect(
        app.tester
            .widget<Visibility>(
              find
                  .ancestor(of: key(k), matching: find.byType(Visibility))
                  .first,
            )
            .visible,
        isFalse,
        reason: k,
      );
    }
    // The detail behind a bar opens on a tap; the metric switches what it
    // shows.
    await app.tester.tap(bars().last);
    await app.settle();
    expect(find.byType(AlertDialog), findsOneWidget);
    expect(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.text('Sep 2, 2026'),
      ),
      findsOneWidget,
    );
    await app.tester.tap(find.widgetWithText(TextButton, en.close));
    await app.settle();
    await app.tester.tap(key('usage-activity-metric-cost'));
    await app.settle();
    expect((bars().evaluate().last.widget as Tooltip).message, contains(r'$2'));

    // Week: daily bars, no calendar, the peak day.
    await period('Week');
    expect(desk.windows.last, (from: '2026-08-31', to: '2026-09-02'));
    expect(key('usage-daily-activity'), findsOneWidget);
    expect(find.byType(UsageHeatmap), findsNothing);
    expect(find.text('PEAK DAY'), findsOneWidget);
    expect(find.text('Mon'), findsWidgets);

    // Day: hourly activity; no streak, no peak day, no weekday bars.
    await period('Day');
    expect(desk.windows.last, (from: '2026-09-02', to: '2026-09-02'));
    expect(key('usage-hourly-activity'), findsOneWidget);
    expect(find.byType(UsageHeatmap), findsNothing);
    for (final text in ['DAY STREAK', 'PEAK DAY', 'Peak day', 'Mon']) {
      expect(find.text(text), findsNothing, reason: text);
    }
    expect(find.textContaining('days active'), findsNothing);
    expect(find.text('Peak hour'), findsOneWidget);

    // The weekday shares use the whole period; a missing day stays unknown.
    desk.serve = (window) {
      final data = usageSample();
      data['hourly'] = null;
      data['weekday'] = {
        'buckets': [
          {'weekday': 0, 'tokens': 10, 'cost': 1, 'requests': 1},
        ],
      };
      data['totals'] = {...part(data, 'totals'), 'tokens': 1000};
      return data;
    };
    await period('Week');
    await period('Month');
    expect(find.text('10 · 1.0%'), findsOneWidget);
    expect(find.text('—'), findsAtLeastNWidgets(6));
    expect(app.tester.takeException(), isNull);

    // A report in another language carries the same figures.
    desk.serve = (_) => usageSample();
    await app.container
        .read(localeControllerProvider.notifier)
        .setLocale(const Locale('zh'));
    await app.settle();
    await period(lookupAppLocalizations(const Locale('zh')).usagePeriodWeek);
    await period(lookupAppLocalizations(const Locale('zh')).usagePeriodMonth);
    expect(
      find.descendant(
        of: key('usage-report-hero'),
        matching: find.text('19.9B'),
      ),
      findsOneWidget,
    );
    final zh = lookupAppLocalizations(const Locale('zh'));
    expect(find.text(zh.usageWhenTitle), findsOneWidget);
    // The peak tile's label and its date follow the language, not English.
    expect(
      find.descendant(
        of: key('usage-report-hero'),
        matching: find.text(zh.usageStatPeakWeek),
      ),
      findsOneWidget,
    );
    expect(find.text('7月27日'), findsOneWidget);
    expect(
      find.descendant(
        of: key('usage-report-agents'),
        matching: find.text(zh.usageByAgent),
      ),
      findsOneWidget,
    );
    for (final text in ['非实际账单', '目录价', '本机全部 agent 活动']) {
      expect(find.textContaining(text), findsNothing, reason: text);
    }
  });

  featureTest('a phone at the largest text size reads the whole report', (
    f,
  ) async {
    final studio = f.network.add('http://studio.test:7734');
    await f.storage.seedServer(studio);
    final desk = UsageDesk(studio)
      ..serve = (window) => window.from == '2026-01-01'
          ? longWindow(window.from, 245)
          : usageSample();
    // The OS asks for twice the text: what the app follows until told not to.
    final device = f.tester.platformDispatcher..textScaleFactorTestValue = 2;
    addTearDown(device.clearTextScaleFactorTestValue);
    final app = await f.launch(
      viewport: FeatureViewport.narrowPhoneTall,
      initialLocation: '$usageReportRoute?period=year',
      overrides: [
        usageNowProvider.overrideWithValue(() => DateTime(2026, 9, 2, 9)),
      ],
    );
    Finder key(String k) => find.byKey(Key(k));
    expect(app.textScale, 2);
    expect(app.tester.takeException(), isNull);

    // The histogram's axis scrolls with its days and opens at the recent ones.
    final chart = key('usage-daily-activity');
    final bars = find.descendant(of: chart, matching: find.byType(Tooltip));
    final viewport = app.tester.getRect(chart);
    final lastLabel = find.descendant(
      of: chart,
      matching: find.text('Sep 2, 2026'),
    );
    final firstLabel = find.descendant(
      of: chart,
      matching: find.text('Jan 1, 2026'),
    );
    expect(app.tester.getRect(bars.last).right, closeTo(viewport.right, 0.1));
    expect(app.tester.getRect(lastLabel).right, closeTo(viewport.right, 0.1));
    expect(app.tester.getRect(firstLabel).right, lessThan(viewport.left));
    final oldBar = app.tester.getRect(bars.last).right;
    final oldLabel = app.tester.getRect(lastLabel).right;
    await app.tester.drag(chart, const Offset(130, 0));
    await app.settle();
    final moved = app.tester.getRect(bars.last).right - oldBar;
    expect(moved, greaterThan(0));
    expect(app.tester.getRect(lastLabel).right - oldLabel, closeTo(moved, 0.1));

    // Every period and language still lays out: the wrapped period control, a
    // step back and back again, the eight sortable columns of the agent table.
    for (final language in const [Locale('en'), Locale('es')]) {
      await app.container
          .read(localeControllerProvider.notifier)
          .setLocale(language);
      final l10n = lookupAppLocalizations(language);
      await app.tester.tap(
        find.descendant(
          of: key('usage-period-switcher'),
          matching: find.text(l10n.usagePeriodMonth),
        ),
      );
      await app.settle();
      expect(app.tester.takeException(), isNull, reason: '$language');
      await app.tester.tap(key('usage-period-previous'));
      await app.settle();
      await app.tester.tap(key('usage-period-current'));
      await app.settle();
      expect(app.tester.takeException(), isNull, reason: '$language');
    }
    final table = app.tester.widget<DataTable>(find.byType(DataTable));
    expect(table.columns, hasLength(8));
    expect(table.columns.every((column) => column.onSort != null), isTrue);
    expect(key('usage-agent-table-scroll'), findsOneWidget);
    expect(desk.windows.first, (from: '2026-01-01', to: '2026-09-02'));
  });

  featureTest('the share section saves what it promises on a desktop', (
    f,
  ) async {
    final studio = f.network.add('http://studio.test:7734');
    await f.storage.seedServer(studio);
    UsageDesk(studio);
    final captured = <GlobalKey>[];
    final written = <String, int>{};
    String? directory = '/exports/pictures';
    var captureWorks = true;
    final app = await f.launch(
      viewport: FeatureViewport.desktopTall,
      initialLocation: usageReportRoute,
      overrides: [
        usageNowProvider.overrideWithValue(() => DateTime(2026, 9, 2, 9)),
        usageExportCaptureProvider.overrideWithValue((boundary) async {
          captured.add(boundary);
          return captureWorks ? Uint8List.fromList([137, 80, 78, 71]) : null;
        }),
        usageExportSinkProvider.overrideWithValue(
          DirectoryUsageExportSink(
            pickDirectory: () async => directory,
            writeFile: (path, bytes) async => written[path] = bytes.length,
          ),
        ),
      ],
    );
    Finder key(String k) => find.byKey(Key(k));
    Future<void> press(String k) async {
      await app.reveal(key(k));
      await app.tester.tap(key(k));
      await app.settle();
    }

    const range = '2026-08-01-2026-08-31';
    final theme = themeSpecById(kDefaultThemeId).id;
    // The section states the boundary before either button, captions each tier
    // and thumbnail, and carries no file-count footnote.
    await app.reveal(key('usage-report-share'));
    final share = key('usage-report-share');
    expect(find.textContaining('Two images, two privacy levels'), findsOne);
    for (final (text, count) in [
      ('Overview card · counts only', 1),
      ('Project detail card', 1),
      ('OVERVIEW', 2),
      ('PROJECT DETAIL', 2),
      ('Light', 2),
      ('Dark', 2),
    ]) {
      expect(
        find.descendant(of: share, matching: find.text(text)),
        findsNWidgets(count),
        reason: text,
      );
    }
    expect(find.textContaining('Each export writes two PNGs'), findsNothing);
    expect(find.textContaining('multiple downloads'), findsNothing);

    // One press of the overview button writes its two cards in the app's theme.
    await press('usage-export-overview');
    expect(written.keys.toList(), [
      '/exports/pictures/cosyncing-usage-$range-overview-$theme-light.png',
      '/exports/pictures/cosyncing-usage-$range-overview-$theme-dark.png',
    ]);
    expect(
      find.text(
        'Saved cosyncing-usage-$range-overview-$theme-light.png and '
        'cosyncing-usage-$range-overview-$theme-dark.png',
      ),
      findsOneWidget,
    );

    // A cancelled folder choice writes nothing and reports nothing.
    written.clear();
    directory = null;
    await press('usage-export-overview');
    expect(written, isEmpty);
    expect(find.textContaining('Saved '), findsNothing);
    expect(find.text(en.usageExportFailed), findsNothing);

    // "All four" writes both tiers in both modes, in one choice.
    directory = '/tmp/out';
    await press('usage-export-all');
    expect(written, hasLength(4));
    expect(
      written.keys.where((path) => path.contains('-projects-')),
      hasLength(2),
    );

    // The names follow the theme the cards wear.
    await app.container
        .read(themeControllerProvider.notifier)
        .selectTheme('graphite-minimalist');
    await app.settle();
    // All four previews wear the selected theme, not the default.
    final graphite = themeSpecById('graphite-minimalist');
    expect(
      app.tester
          .elementList(find.byType(UsageExportCard))
          .map((element) => element.tokens.canvas)
          .toSet(),
      {graphite.light.canvas, graphite.dark.canvas},
    );
    written.clear();
    await press('usage-export-projectDetail');
    expect(
      written.keys,
      everyElement(contains('-projects-graphite-minimalist-')),
    );
    expect(written, hasLength(2));

    // The agent table exports its own CSV, named for the window.
    written.clear();
    await press('usage-export-csv');
    expect(
      written.keys.single,
      '/tmp/out/cosyncing-usage-2026-08-01-2026-08-31.csv',
    );

    // A card that cannot be captured says so and writes nothing.
    written.clear();
    captureWorks = false;
    await press('usage-export-overview');
    expect(written, isEmpty);
    expect(find.text(en.usageExportFailed), findsOneWidget);

    // The catalog of readable sources names what is read, and nothing else.
    await app.reveal(key('usage-source-catalog'));
    await app.tester.tap(key('usage-source-catalog'));
    await app.settle();
    expect(find.text('MiniMax Code'), findsOneWidget);
    for (final text in ['Command Code', 'Z.ai', 'Cursor']) {
      expect(find.text(text), findsNothing, reason: text);
    }
    expect(app.tester.takeException(), isNull);
  });

  featureTest(
    'an Android export goes to the share sheet and says so',
    (f) async {
      final studio = f.network.add('http://studio.test:7734');
      await f.storage.seedServer(studio);
      UsageDesk(studio);
      var status = ShareResultStatus.success;
      final shared = <List<String>>[];
      final app = await f.launch(
        viewport: FeatureViewport.phoneTall,
        initialLocation: usageReportRoute,
        overrides: [
          usageNowProvider.overrideWithValue(() => DateTime(2026, 9, 2, 9)),
          usageExportCaptureProvider.overrideWithValue(
            (_) async => Uint8List.fromList([137, 80, 78, 71]),
          ),
          usageExportSinkProvider.overrideWithValue(
            ShareSheetUsageExportSink(
              share: (files) async {
                shared.add([for (final file in files) file.name]);
                return status;
              },
            ),
          ),
        ],
      );
      Finder key(String k) => find.byKey(Key(k));
      Future<void> press(String k) async {
        await app.reveal(key(k));
        await app.tester.tap(key(k));
        await app.settle();
      }

      await press('usage-export-overview');
      expect(shared.single, hasLength(2));
      expect(find.textContaining('Shared '), findsOneWidget);
      expect(find.textContaining('Saved '), findsNothing);

      // Dismissing the sheet is a cancel; an unreadable answer is a success.
      shared.clear();
      status = ShareResultStatus.dismissed;
      await press('usage-export-overview');
      expect(shared, hasLength(1));
      expect(find.textContaining('Shared '), findsNothing);
      status = ShareResultStatus.unavailable;
      await press('usage-export-all');
      expect(shared.last, hasLength(4));
      expect(find.textContaining('Shared '), findsOneWidget);

      // The agent table's CSV goes through the same sheet.
      await press('usage-export-csv');
      expect(shared.last.single, endsWith('.csv'));
      expect(app.tester.takeException(), isNull);
    },
    platform: TargetPlatform.android,
  );

  featureTest(
    'iOS says export is not offered and shows no buttons',
    (f) async {
      final studio = f.network.add('http://studio.test:7734');
      await f.storage.seedServer(studio);
      UsageDesk(studio);
      final app = await f.launch(
        viewport: FeatureViewport.phoneTall,
        initialLocation: usageReportRoute,
        overrides: [
          usageNowProvider.overrideWithValue(() => DateTime(2026, 9, 2, 9)),
        ],
      );
      await app.reveal(find.byKey(const Key('usage-export-unsupported')));
      expect(find.text(en.usageExportDesktopOnly), findsOneWidget);
      for (final k in [
        'usage-export-overview',
        'usage-export-projectDetail',
        'usage-export-csv',
      ]) {
        expect(find.byKey(Key(k)), findsNothing, reason: k);
      }
    },
    platform: TargetPlatform.iOS,
  );
}
