import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_export_service.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_format.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_period.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_export_card.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_share_section.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';
import 'package:share_plus/share_plus.dart';

Map<String, dynamic> sampleReport() =>
    jsonDecode(
          File(
            '../../contracts/generated/usage-report.sample.json',
          ).readAsStringSync(),
        )
        as Map<String, dynamic>;

UsageReport report() =>
    UsageReportResponse.fromJson({'ok': true, 'data': sampleReport()}).report!;

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

  test('a day card names neither days active nor a busiest day', () {
    bool mentions(UsagePeriod period, String text) =>
        planFor(period: period).texts.any((line) => line.contains(text));
    // The month card still carries both, so the day's omission is not a
    // sample that stopped serving them.
    for (final text in ['days active', 'Busiest day']) {
      expect(mentions(UsagePeriod.month, text), isTrue, reason: text);
      expect(mentions(UsagePeriod.today, text), isFalse, reason: text);
    }
    expect(mentions(UsagePeriod.today, 'sessions'), isTrue);
  });

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

    test('every rank prints all it has when the rung holds', () {
      // The sample serves two models and two projects; add thirds so the
      // ladder has something to admit, and all of them must fit on the first
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
      // The rung the fitter held, not the row count: the card asks for five
      // and prints the three that exist.
      expect(plan.maxProjects, usageRankingRows);
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
    // cells and, on the project tier, the ladder's top rung, with the full
    // 12px of breathing room the first pass asks for.
    final overview = planFor(includeCost: true);
    expect(overview.cellCap, 11);
    expect(overview.slack, greaterThanOrEqualTo(12));

    final projects = planFor(
      kind: UsageExportCardKind.projectDetail,
      includeCost: true,
    );
    expect(projects.maxProjects, usageRankingRows);
    expect(projects.cellCap, 11);
    expect(projects.slack, greaterThanOrEqualTo(12));
  });

  testWidgets('a dense period drops project rows rather than overflowing', (
    tester,
  ) async {
    // A machine running five harnesses across five models, with five long
    // repository names, is ordinary and taller than the frame. The ladder
    // answers by taking fewer project rows at smaller heat cells; text never
    // shrinks, and the harness and model blocks never give a row back.
    final data = sampleReport();
    (data['tools']! as List<dynamic>).addAll([
      for (var index = 0; index < 3; index++)
        {
          'tool': 'harness_$index',
          'label': 'Harness $index',
          'coding': true,
          'tokens': 1500000000 - index * 100000000,
          'cost': 400.0,
          'requests': 9000,
          'sessions': 40,
        },
    ]);
    (data['topModelsByTokens']! as List<dynamic>).addAll([
      for (var index = 0; index < 3; index++)
        {
          'name': 'a-rather-long-model-name-$index',
          'tokens': 1400000000 - index * 100000000,
          'cost': 380.0,
          'requests': 8000,
        },
    ]);
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
    expect(plan.maxProjects, lessThan(usageRankingRows));
    final shown = plan.texts.where((text) => text.contains('a_rather_long'));
    expect(shown.length, plan.maxProjects);
    // The ranks above keep their full five: a project row is what the ladder
    // spends, because the reader can lose one repository name and still read
    // the card, and losing a harness makes it claim a machine that isn't this
    // one.
    final harnesses = [
      for (final tool in dense.tools.take(usageRankingRows))
        tool.label ?? tool.tool,
    ];
    expect(harnesses, hasLength(usageRankingRows));
    for (final name in harnesses) {
      expect(plan.texts, contains(name), reason: name);
    }
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
  });

  group('platforms without a directory sink', () {
    test('iOS is the one platform with no destination at all', () {
      expect(usageExportSupportedOn(TargetPlatform.iOS), isFalse);
      expect(usageExportSupportedOn(TargetPlatform.android), isTrue);
      expect(usageExportSupportedOn(TargetPlatform.linux), isTrue);
      expect(usageExportSupportedOn(TargetPlatform.macOS), isTrue);
      expect(usageExportSupportedOn(TargetPlatform.windows), isTrue);
    });

    test('Android shares; every other platform writes a folder', () {
      expect(usageExportSharesOn(TargetPlatform.android), isTrue);
      expect(usageExportSharesOn(TargetPlatform.iOS), isFalse);
      expect(usageExportSharesOn(TargetPlatform.linux), isFalse);
      expect(usageExportSharesOn(TargetPlatform.macOS), isFalse);
      expect(usageExportSharesOn(TargetPlatform.windows), isFalse);
    });

    group('the share sheet', () {
      final files = [
        UsageExportFile(
          name: 'light.png',
          bytes: Uint8List.fromList(const [137, 80, 78, 71]),
        ),
        UsageExportFile(
          name: 'dark.png',
          bytes: Uint8List.fromList(const [137, 80, 78, 71]),
        ),
      ];

      test('takes every file in one gesture', () async {
        var calls = 0;
        List<UsageExportFile>? handed;
        final sink = ShareSheetUsageExportSink(
          share: (shared) async {
            calls += 1;
            handed = shared;
            return ShareResultStatus.success;
          },
        );

        expect(await sink.write(files), ['light.png', 'dark.png']);
        // One sheet, not one per image: four cards are one export.
        expect(calls, 1);
        expect(handed, hasLength(2));
      });

      test('a dismissed sheet is a cancel, not a success', () async {
        final sink = ShareSheetUsageExportSink(
          share: (_) async => ShareResultStatus.dismissed,
        );

        expect(await sink.write(files), isNull);
      });

      test('an undetermined destination is still a success', () async {
        // The platform shared the files and declined to say where. Reporting
        // that as a cancel would tell the sender nothing happened when it did.
        final sink = ShareSheetUsageExportSink(
          share: (_) async => ShareResultStatus.unavailable,
        );

        expect(await sink.write(files), ['light.png', 'dark.png']);
      });
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

  testWidgets('a rebuild with the same inputs keeps the fitted plan', (
    tester,
  ) async {
    // Fitting lays the card out many times over; the share section rebuilds
    // its four previews on every toggle and theme change.
    final spec = themeSpecById(kDefaultThemeId);
    final served = report();
    var includeCost = false;
    late StateSetter rebuild;
    await tester.pumpWidget(
      MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: buildAppTheme(spec.light, Brightness.light),
        home: Center(
          child: StatefulBuilder(
            builder: (context, setState) {
              rebuild = setState;
              return UsageExportCard(
                kind: UsageExportCardKind.overview,
                period: UsagePeriod.month,
                report: served,
                locale: 'en',
                includeCost: includeCost,
              );
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    // The painter repaints exactly when it was handed a different plan.
    CustomPainter painter() => tester
        .widget<CustomPaint>(
          find
              .descendant(
                of: find.byType(UsageExportCard),
                matching: find.byType(CustomPaint),
              )
              .first,
        )
        .painter!;

    final fitted = painter();
    rebuild(() {});
    await tester.pump();
    final kept = painter();
    expect(kept.shouldRepaint(fitted), isFalse);

    rebuild(() => includeCost = true);
    await tester.pump();
    expect(painter().shouldRepaint(kept), isTrue);
  });
}
