import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_export_service.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_report_api.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_period.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_export_card.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_report_page.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_share_section.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';

Map<String, dynamic> sampleReport() =>
    jsonDecode(
          File(
            '../../contracts/generated/usage-report.sample.json',
          ).readAsStringSync(),
        )
        as Map<String, dynamic>;

UsageReport report() =>
    UsageReportResponse.fromJson({'ok': true, 'data': sampleReport()}).report!;

class _StubApi implements UsageReportApi {
  _StubApi([this.data]);

  final Map<String, dynamic>? data;

  @override
  Future<UsageReportResponse> getReport({
    required String from,
    required String to,
  }) async => UsageReportResponse.fromJson({
    'ok': true,
    'data': data ?? sampleReport(),
  });
}

class _RecordingSink implements UsageExportSink {
  final List<UsageExportFile> written = [];
  bool cancel = false;

  @override
  Future<List<String>?> write(List<UsageExportFile> files) async {
    if (cancel) return null;
    written.addAll(files);
    return files.map((file) => file.name).toList();
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() async {
    // The plan titles and ranges go through DateFormat with an explicit
    // locale, and plain tests never run the app's delegates.
    await initializeDateFormatting('en');
    await initializeDateFormatting('zh');
  });

  setUp(() {
    // A 640-tall card does not fit the 800x600 default surface, and a squeezed
    // card would report an overflow that says nothing about the design.
    final view =
        TestWidgetsFlutterBinding.instance.platformDispatcher.views.first
          ..physicalSize = const Size(1200, 1800)
          ..devicePixelRatio = 1;
    addTearDown(() {
      view
        ..resetPhysicalSize()
        ..resetDevicePixelRatio();
    });
  });

  Widget card({
    required UsageExportCardKind kind,
    UsagePeriod period = UsagePeriod.month,
    Brightness brightness = Brightness.light,
    Locale locale = const Locale('en'),
    bool includeCost = false,
    GlobalKey? boundaryKey,
  }) {
    final spec = themeSpecById(kDefaultThemeId);
    final tokens = brightness == Brightness.dark ? spec.dark : spec.light;
    return MaterialApp(
      locale: locale,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      theme: buildAppTheme(tokens, brightness),
      home: Center(
        child: RepaintBoundary(
          key: boundaryKey ?? GlobalKey(),
          child: UsageExportCard(
            kind: kind,
            period: period,
            report: report(),
            locale: locale.toLanguageTag(),
            includeCost: includeCost,
          ),
        ),
      ),
    );
  }

  /// The card's layout is a data structure before it is a widget, so content
  /// and fit assertions run against the plan itself rather than against pixels
  /// in a `CustomPaint`.
  UsageExportCardPlan planFor({
    UsageExportCardKind kind = UsageExportCardKind.overview,
    UsagePeriod period = UsagePeriod.month,
    UsageReport? forReport,
    String locale = 'en',
    Brightness brightness = Brightness.light,
    bool includeCost = false,
  }) {
    final spec = themeSpecById(kDefaultThemeId);
    final tokens = brightness == Brightness.dark ? spec.dark : spec.light;
    final theme = buildAppTheme(tokens, brightness);
    return UsageExportCardPlan.fit(
      kind: kind,
      period: period,
      report: forReport ?? report(),
      locale: locale,
      includeCost: includeCost,
      l10n: lookupAppLocalizations(Locale(locale)),
      tokens: tokens,
      baseStyle: theme.textTheme.bodySmall!,
    );
  }

  group('the privacy boundary is which card, not a setting', () {
    test('the overview card carries no project name', () {
      final texts = planFor().texts;
      // The fixture's projects are named atlas and atlas_private.
      expect(texts.where((text) => text.contains('atlas')), isEmpty);
      // No manifest, no qualifier: the tier eyebrow is the whole statement.
      expect(texts.where((text) => text.contains('prompt text')), isEmpty);
      expect(texts.where((text) => text.contains('list-price')), isEmpty);
      expect(texts, contains('COSYNCING · OVERVIEW'));
    });

    test('the project card names them, and its eyebrow says so', () {
      final texts = planFor(kind: UsageExportCardKind.projectDetail).texts;
      expect(texts, contains('atlas'));
      expect(texts, contains('COSYNCING · PROJECT DETAIL'));
      // The manifest and reconciliation lines are gone: the eyebrow carries
      // the privacy positioning now.
      expect(
        texts.where((text) => text.contains('share deliberately')),
        isEmpty,
      );
      expect(
        texts.where((text) => text.contains('Grouped by repository')),
        isEmpty,
      );
    });

    test('three of each rank land when three exist', () {
      // The sample serves two models and two projects; add thirds so the
      // ladder has something to admit, and all three must fit on the first
      // rung of an ordinary month.
      final data = sampleReport();
      (data['topModelsByTokens']! as List<dynamic>).add({
        'name': 'kimi-k2.5',
        'tokens': 3000000000,
        'cost': 900.0,
        'requests': 24000,
      });
      (data['projects']! as Map<String, dynamic>)['rows'] = [
        ...(data['projects']! as Map<String, dynamic>)['rows']!
            as List<dynamic>,
        {
          'project': 'tokdash',
          'tokens': 2500000000,
          'cost': 800.0,
          'requests': 20000,
        },
      ];
      final plan = planFor(
        kind: UsageExportCardKind.projectDetail,
        forReport: UsageReportResponse.fromJson({
          'ok': true,
          'data': data,
        }).report,
        includeCost: true,
      );
      expect(plan.maxProjects, 3);
      expect(plan.slack, greaterThanOrEqualTo(12));
      for (final name in [
        'Claude Code',
        'Codex',
        'openclaw',
        'claude-opus-5',
        'gpt-5.6-sol',
        'kimi-k2.5',
        'atlas',
        'atlas_private',
        'tokdash',
      ]) {
        expect(plan.texts, contains(name), reason: name);
      }
    });

    test('no toggle moves content across the boundary', () {
      // Cost is the only toggle, and it is green tier on both cards.
      final texts = planFor(includeCost: true).texts;
      // tokdash's card cost: two decimals, never compacted, no qualifier.
      expect(texts, contains(r'$12976.51'));
      expect(texts.where((text) => text.contains('atlas')), isEmpty);
    });

    test('cost is absent unless it was asked for', () {
      for (final kind in UsageExportCardKind.values) {
        final texts = planFor(kind: kind).texts;
        expect(texts.where((text) => text.contains(r'$')), isEmpty);
      }
    });

    test('prompt text appears on neither card', () {
      for (final kind in UsageExportCardKind.values) {
        for (final text in planFor(kind: kind, includeCost: true).texts) {
          expect(text.contains('display_name'), isFalse);
        }
      }
    });
  });

  group('the card fits its frame', () {
    testWidgets('at exactly 360 x 640 in both locales and brightnesses', (
      tester,
    ) async {
      for (final locale in [const Locale('en'), const Locale('zh')]) {
        for (final brightness in usageExportBrightnesses) {
          for (final kind in UsageExportCardKind.values) {
            await tester.pumpWidget(
              card(
                kind: kind,
                brightness: brightness,
                locale: locale,
                includeCost: true,
              ),
            );
            await tester.pumpAndSettle();

            final size = tester.getSize(find.byType(UsageExportCard));
            expect(size.width, usageExportCardWidth);
            expect(size.height, usageExportCardHeight);
            expect(
              tester.takeException(),
              isNull,
              reason: '$kind $locale $brightness',
            );
          }
        }
      }
    });

    test('the sample month lands inside the budget in both locales', () {
      for (final locale in ['en', 'zh']) {
        for (final kind in UsageExportCardKind.values) {
          final plan = planFor(kind: kind, locale: locale, includeCost: true);
          expect(plan.slack, greaterThanOrEqualTo(0), reason: '$kind $locale');
        }
      }
    });
  });

  test('an ordinary period fits on the first rung of the ladder', () {
    // The fitter exists so a dense period cannot overflow, not so every card
    // drops content it had room for. The sample month keeps the densest heat
    // cells and, on the project tier, all three project rows, with the full
    // 12px of breathing room the first pass asks for.
    final overview = planFor(includeCost: true);
    expect(overview.cellCap, 11);
    expect(overview.slack, greaterThanOrEqualTo(12));

    final projects = planFor(
      kind: UsageExportCardKind.projectDetail,
      includeCost: true,
    );
    expect(projects.maxProjects, 3);
    expect(projects.cellCap, 11);
    expect(projects.slack, greaterThanOrEqualTo(12));
  });

  testWidgets('a dense period drops project rows rather than overflowing', (
    tester,
  ) async {
    // Five projects with long names is ordinary on a real machine and taller
    // than the frame. The ladder answers by taking fewer rows at smaller heat
    // cells; text never shrinks.
    final data = sampleReport();
    (data['projects']! as Map<String, dynamic>)['rows'] = [
      for (var index = 0; index < 5; index++)
        {
          'project': 'a_rather_long_repository_name_$index',
          'tokens': 4000000000 - index * 100000000,
          'cost': 2400.0,
          'requests': 20000,
        },
    ];
    final dense = UsageReportResponse.fromJson({
      'ok': true,
      'data': data,
    }).report!;

    final plan = planFor(
      kind: UsageExportCardKind.projectDetail,
      forReport: dense,
      includeCost: true,
    );
    expect(plan.slack, greaterThanOrEqualTo(0));
    expect(plan.maxProjects, lessThan(5));
    final shown = plan.texts.where((text) => text.contains('a_rather_long'));
    expect(shown.length, plan.maxProjects);
    // The section survives even when the rows don't all fit: the label is the
    // promise, the ladder is the admission.
    expect(plan.texts, contains('TOP PROJECTS'));

    final spec = themeSpecById(kDefaultThemeId);
    await tester.pumpWidget(
      MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: buildAppTheme(spec.light, Brightness.light),
        home: Center(
          child: UsageExportCard(
            kind: UsageExportCardKind.projectDetail,
            period: UsagePeriod.month,
            report: dense,
            locale: 'en',
            includeCost: true,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    final size = tester.getSize(find.byType(UsageExportCard));
    expect(size.width, usageExportCardWidth);
    expect(size.height, usageExportCardHeight);
  });

  test('a projects tier with no facet says so instead of going silent', () {
    final data = sampleReport()..remove('projects');
    final noProjects = UsageReportResponse.fromJson({
      'ok': true,
      'data': data,
    }).report;
    final plan = planFor(
      kind: UsageExportCardKind.projectDetail,
      forReport: noProjects,
    );
    expect(
      plan.texts,
      contains('project records unavailable on this server'),
    );
  });

  group('the heat block follows the period', () {
    test('a week carries no block', () {
      final plan = planFor(period: UsagePeriod.week);
      expect(plan.heatCells, 0);
      expect(plan.heatLeft, isNull);
    });

    test('a month pins its weekday grid to the left edge', () {
      // August 2026 starts on a Saturday and the sample serves the whole
      // month: 31 cells at the 16px cap, 6px gaps, left edge at the 24px
      // gutter, and no pretence of filling the card width.
      final plan = planFor(includeCost: true);
      expect(plan.heatCells, 31);
      expect(plan.heatLeft, 24);
      expect(plan.heatRight, 24 + 7 * 16 + 6 * 6);
    });

    test('a month in progress extends to the calendar month end', () {
      final data = sampleReport();
      (data['range']! as Map<String, dynamic>)['to'] = '2026-08-23';
      final plan = planFor(
        forReport: UsageReportResponse.fromJson({
          'ok': true,
          'data': data,
        }).report,
      );
      // The unelapsed tail draws as outlined empty cells, so card and page
      // show the same full-month grid.
      expect(plan.heatCells, 31);
    });

    test('a year fills the content edge to edge', () {
      final data = sampleReport();
      final range = data['range']! as Map<String, dynamic>;
      range['from'] = '2026-01-01';
      range['to'] = '2026-09-08';
      range['days'] = 251;
      final plan = planFor(
        period: UsagePeriod.year,
        forReport: UsageReportResponse.fromJson({
          'ok': true,
          'data': data,
        }).report,
      );
      expect(plan.heatCells, 251);
      expect(plan.heatLeft, 24);
      // The gap is solved after the cell, so the last column lands exactly on
      // the right content edge.
      expect(plan.heatRight, closeTo(336, 0.01));
    });
  });

  group('harness marks on the card', () {
    test('pin to the left gutter on tokdash’s 23px row pitch', () {
      // tokdash rankRow: a 15px mark at (L, top − 1), the name at L + 19 with
      // its baseline at top + 11×0.78, then 15px of row and an 8px gap after
      // the bar — 23px from one mark to the next.
      final plan = planFor(includeCost: true);
      expect(plan.icons.length, 3);
      for (final spot in plan.icons) {
        expect(spot.x, 24);
      }
      for (var i = 1; i < plan.icons.length; i++) {
        expect(plan.icons[i].y - plan.icons[i - 1].y, closeTo(23, 0.01));
      }
    });
  });

  group('capture', () {
    testWidgets('renders 1800 x 3200 from a 360 x 640 card', (tester) async {
      final key = GlobalKey();
      await tester.pumpWidget(
        card(kind: UsageExportCardKind.overview, boundaryKey: key),
      );
      await tester.pumpAndSettle();

      // Rasterizing is real engine work; the test binding's fake async never
      // completes it.
      final bytes = await tester.runAsync(
        () => captureUsageExportCard(key),
      );
      expect(bytes, isNotNull);

      final decoded = await tester.runAsync(
        () => decodeImageFromList(bytes!),
      );
      expect(decoded!.width, 1800);
      expect(decoded.height, 3200);
      // A PNG, because that is what the sink claims to write.
      expect(
        bytes!.sublist(0, 8),
        Uint8List.fromList([137, 80, 78, 71, 13, 10, 26, 10]),
      );
    });

    testWidgets('a boundary that never rendered captures nothing', (
      tester,
    ) async {
      expect(await captureUsageExportCard(GlobalKey()), isNull);
    });
  });

  group('share section', () {
    Widget shareSubject(
      _RecordingSink sink, {
      Size size = const Size(1100, 3400),
    }) {
      final spec = themeSpecById(kDefaultThemeId);
      return ProviderScope(
        overrides: [
          usageNowProvider.overrideWithValue(() => DateTime(2026, 9, 2)),
          usageReportApiProvider.overrideWithValue(_StubApi()),
          usageExportSinkProvider.overrideWithValue(sink),
          usageExportCaptureProvider.overrideWithValue(
            (key) async => Uint8List.fromList(const [137, 80, 78, 71]),
          ),
          // flutter_test reports Android, where the export is deliberately not
          // offered. Pinned so these cases exercise the platforms that have it.
          usageExportSupportedProvider.overrideWithValue(true),
        ],
        child: MaterialApp(
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

    testWidgets('one press writes both themes', (tester) async {
      final sink = _RecordingSink();
      await tester.pumpWidget(shareSubject(sink));
      await tester.pumpAndSettle();

      final button = find.byKey(const Key('usage-export-overview'));
      await tester.ensureVisible(button);
      await tester.pumpAndSettle();
      await tester.tap(button);
      await tester.pumpAndSettle();

      expect(sink.written, hasLength(2));
      expect(
        sink.written.first.name,
        endsWith('-overview-teal-obsidian-light.png'),
      );
      expect(
        sink.written.last.name,
        endsWith('-overview-teal-obsidian-dark.png'),
      );
      // The sender never chose a theme, and never had to.
      expect(find.textContaining('Saved '), findsOneWidget);
    });

    testWidgets('the file name says which card and which window', (
      tester,
    ) async {
      final sink = _RecordingSink();
      await tester.pumpWidget(shareSubject(sink));
      await tester.pumpAndSettle();

      final button = find.byKey(const Key('usage-export-projectDetail'));
      await tester.ensureVisible(button);
      await tester.pumpAndSettle();
      await tester.tap(button);
      await tester.pumpAndSettle();

      expect(
        sink.written.first.name,
        'cosyncing-usage-2026-08-01-2026-08-31-'
        'projects-teal-obsidian-light.png',
      );
    });

    testWidgets('the file name carries the selected theme, not the default', (
      tester,
    ) async {
      // The card wears the selected palette, so the name must say which: an
      // amber export and a teal one of the same window are different images.
      final sink = _RecordingSink();
      final spec = kAppThemes.firstWhere(
        (theme) => theme.id != kDefaultThemeId,
      );
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            usageNowProvider.overrideWithValue(() => DateTime(2026, 9, 2)),
            usageReportApiProvider.overrideWithValue(_StubApi()),
            usageExportSinkProvider.overrideWithValue(sink),
            usageExportCaptureProvider.overrideWithValue(
              (key) async => Uint8List.fromList(const [137, 80, 78, 71]),
            ),
            usageExportSupportedProvider.overrideWithValue(true),
          ],
          child: MaterialApp(
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
            theme: buildAppTheme(spec.light, Brightness.light),
            home: const MediaQuery(
              data: MediaQueryData(size: Size(1100, 3400)),
              child: UsageReportPage(),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final button = find.byKey(const Key('usage-export-overview'));
      await tester.ensureVisible(button);
      await tester.pumpAndSettle();
      await tester.tap(button);
      await tester.pumpAndSettle();

      expect(sink.written, hasLength(2));
      expect(
        sink.written.first.name,
        'cosyncing-usage-2026-08-01-2026-08-31-overview-${spec.id}-light.png',
      );
      expect(sink.written.last.name, endsWith('-${spec.id}-dark.png'));
    });

    testWidgets('a cancelled save reports nothing, not a success', (
      tester,
    ) async {
      final sink = _RecordingSink()..cancel = true;
      await tester.pumpWidget(shareSubject(sink));
      await tester.pumpAndSettle();

      final button = find.byKey(const Key('usage-export-overview'));
      await tester.ensureVisible(button);
      await tester.pumpAndSettle();
      await tester.tap(button);
      await tester.pumpAndSettle();

      expect(find.textContaining('Saved '), findsNothing);
      expect(find.textContaining('Could not write'), findsNothing);
    });

    testWidgets('the preamble states the boundary before either button', (
      tester,
    ) async {
      await tester.pumpWidget(shareSubject(_RecordingSink()));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('usage-report-share')), findsOneWidget);
      expect(
        find.textContaining('Two images, two privacy levels'),
        findsOneWidget,
      );
      expect(
        find.textContaining('Each export writes two PNGs'),
        findsOneWidget,
      );
    });

    testWidgets('each tier wears its rail, brief and captioned thumbnails', (
      tester,
    ) async {
      await tester.pumpWidget(shareSubject(_RecordingSink()));
      await tester.pumpAndSettle();

      final share = find.byKey(const Key('usage-report-share'));
      expect(
        find.descendant(
          of: share,
          matching: find.text('Overview card · counts only'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(of: share, matching: find.text('Project detail card')),
        findsOneWidget,
      );
      // Every thumbnail is captioned with its tier chip and the mode it
      // paints, so the reader can tell the four previews apart at a glance.
      expect(
        find.descendant(of: share, matching: find.text('OVERVIEW')),
        findsNWidgets(2),
      );
      expect(
        find.descendant(of: share, matching: find.text('PROJECT DETAIL')),
        findsNWidgets(2),
      );
      expect(
        find.descendant(of: share, matching: find.text('light')),
        findsNWidgets(2),
      );
      expect(
        find.descendant(of: share, matching: find.text('dark')),
        findsNWidgets(2),
      );
    });

    testWidgets('export all four writes both tiers in both themes', (
      tester,
    ) async {
      final sink = _RecordingSink();
      await tester.pumpWidget(shareSubject(sink));
      await tester.pumpAndSettle();

      final button = find.byKey(const Key('usage-export-all'));
      await tester.ensureVisible(button);
      await tester.pumpAndSettle();
      await tester.tap(button);
      await tester.pumpAndSettle();

      expect(sink.written, hasLength(4));
      const prefix = 'cosyncing-usage-2026-08-01-2026-08-31';
      expect(
        sink.written.map((file) => file.name),
        containsAll([
          for (final tier in ['overview', 'projects'])
            for (final mode in ['light', 'dark'])
              '$prefix-$tier-teal-obsidian-$mode.png',
        ]),
      );
    });

    testWidgets('a withheld project facet drops the all-four press too', (
      tester,
    ) async {
      // "All four" promises the project tier; with names withheld it would
      // write two files and claim four.
      final data = sampleReport()
        ..remove('projects')
        ..['projectsUnavailable'] = 'owner-only';
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            usageNowProvider.overrideWithValue(() => DateTime(2026, 9, 2)),
            usageReportApiProvider.overrideWithValue(
              _StubApi(data),
            ),
            usageExportSinkProvider.overrideWithValue(_RecordingSink()),
            usageExportCaptureProvider.overrideWithValue(
              (key) async => Uint8List.fromList(const [137, 80, 78, 71]),
            ),
            usageExportSupportedProvider.overrideWithValue(true),
          ],
          child: MaterialApp(
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
            theme: buildAppTheme(
              themeSpecById(kDefaultThemeId).light,
              Brightness.light,
            ),
            home: const MediaQuery(
              data: MediaQueryData(size: Size(1100, 3400)),
              child: UsageReportPage(),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('usage-export-overview')), findsOneWidget);
      expect(find.byKey(const Key('usage-export-projectDetail')), findsNothing);
      expect(find.byKey(const Key('usage-export-all')), findsNothing);
    });
  });

  group('the previews follow the app theme', () {
    test('every registered theme resolves from its own tokens', () {
      // `buildAppTheme` attaches the spec's exact AppTokens instance as the
      // theme extension, so `identical()` hits in steady state; the
      // accent/canvas/surface2 comparison covers an equal copy. A lerped
      // mid-transition palette deliberately falls back to the default rather
      // than claiming a theme it is halfway out of.
      for (final spec in kAppThemes) {
        expect(usageThemeSpecFor(spec.light), spec, reason: spec.id);
        expect(usageThemeSpecFor(spec.dark), spec, reason: spec.id);
      }
    });

    testWidgets('the rendered cards wear the selected theme, not the default', (
      tester,
    ) async {
      final spec = kAppThemes.firstWhere(
        (theme) => theme.id != kDefaultThemeId,
      );
      final fallback = themeSpecById(kDefaultThemeId);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            usageNowProvider.overrideWithValue(() => DateTime(2026, 9, 2)),
            usageReportApiProvider.overrideWithValue(_StubApi()),
            usageExportCaptureProvider.overrideWithValue((key) async => null),
            usageExportSupportedProvider.overrideWithValue(true),
          ],
          child: MaterialApp(
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
            theme: buildAppTheme(spec.light, Brightness.light),
            home: const MediaQuery(
              data: MediaQueryData(size: Size(1100, 3400)),
              child: UsageReportPage(),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byKey(const Key('usage-report-share')));
      await tester.pumpAndSettle();

      final cards = tester.elementList(find.byType(UsageExportCard)).toList();
      // Two tiers, each previewed in both themes.
      expect(cards, hasLength(4));
      final canvases = cards.map((element) => element.tokens.canvas).toSet();
      expect(canvases, {spec.light.canvas, spec.dark.canvas});
      expect(canvases.contains(fallback.light.canvas), isFalse);
      expect(canvases.contains(fallback.dark.canvas), isFalse);
    });
  });

  group('platforms without a directory sink', () {
    Widget subject({bool supported = true, bool isBrowser = false}) {
      final spec = themeSpecById(kDefaultThemeId);
      return ProviderScope(
        overrides: [
          usageNowProvider.overrideWithValue(() => DateTime(2026, 9, 2)),
          usageReportApiProvider.overrideWithValue(_StubApi()),
          usageExportCaptureProvider.overrideWithValue((key) async => null),
          usageExportSupportedProvider.overrideWithValue(supported),
          usageExportIsBrowserProvider.overrideWithValue(isBrowser),
        ],
        child: MaterialApp(
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          theme: buildAppTheme(spec.light, Brightness.light),
          home: const MediaQuery(
            data: MediaQueryData(size: Size(1100, 3400)),
            child: UsageReportPage(),
          ),
        ),
      );
    }

    testWidgets('mobile is told where export runs, not given a dead button', (
      tester,
    ) async {
      await tester.pumpWidget(subject(supported: false));
      await tester.pumpAndSettle();

      // Not a button that fails: `file_selector_ios` has no directory picker at
      // all, and Android's answers with a path scoped storage will not let this
      // app write. A failing press would read as a bug in the report.
      expect(find.byKey(const Key('usage-export-unsupported')), findsOneWidget);
      expect(find.byKey(const Key('usage-export-overview')), findsNothing);
      expect(find.byKey(const Key('usage-export-projectDetail')), findsNothing);
      expect(find.byKey(const Key('usage-export-cost')), findsNothing);
    });

    test('the capability names the two platforms with no sink', () {
      expect(usageExportSupportedOn(TargetPlatform.iOS), isFalse);
      expect(usageExportSupportedOn(TargetPlatform.android), isFalse);
      expect(usageExportSupportedOn(TargetPlatform.linux), isTrue);
      expect(usageExportSupportedOn(TargetPlatform.macOS), isTrue);
      expect(usageExportSupportedOn(TargetPlatform.windows), isTrue);
    });

    testWidgets('the browser is told it may be asked about the second file', (
      tester,
    ) async {
      await tester.pumpWidget(subject(isBrowser: true));
      await tester.pumpAndSettle();

      expect(
        find.textContaining('may ask to allow multiple downloads'),
        findsOneWidget,
      );
    });

    testWidgets('that note is absent where the app owns the destination', (
      tester,
    ) async {
      await tester.pumpWidget(subject());
      await tester.pumpAndSettle();

      expect(
        find.textContaining('may ask to allow multiple downloads'),
        findsNothing,
      );
    });
  });

  test('the browser sink spaces its two handovers', () async {
    final order = <String>[];
    final sink = BrowserUsageExportSink(
      betweenFiles: const Duration(milliseconds: 40),
      handOver: (file) async => order.add(file.name),
    );

    final written = sink.write([
      UsageExportFile(name: 'light.png', bytes: Uint8List.fromList(const [1])),
      UsageExportFile(name: 'dark.png', bytes: Uint8List.fromList(const [2])),
    ]);
    // Chrome gates a second download from one gesture, and a page that starts
    // both in the same tick can have the second dropped with nothing to catch.
    await Future<void>.delayed(const Duration(milliseconds: 10));
    expect(order, ['light.png'], reason: 'both files went over in one tick');

    expect(await written, ['light.png', 'dark.png']);
    expect(order, ['light.png', 'dark.png']);
  });
}
