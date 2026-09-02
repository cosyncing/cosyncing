import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_export_service.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_report_api.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_export_card.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_report_page.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_share_section.dart';
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

UsageReport report() =>
    UsageReportResponse.fromJson({'ok': true, 'data': sampleReport()}).report!;

class _StubApi implements UsageReportApi {
  @override
  Future<UsageReportResponse> getReport({
    required String from,
    required String to,
  }) async => UsageReportResponse.fromJson({
    'ok': true,
    'data': sampleReport(),
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
            report: report(),
            machineLabel: 'This machine',
            locale: locale.toLanguageTag(),
            includeCost: includeCost,
          ),
        ),
      ),
    );
  }

  group('the privacy boundary is which card, not a setting', () {
    testWidgets('the overview card carries no project name', (tester) async {
      await tester.pumpWidget(card(kind: UsageExportCardKind.overview));
      await tester.pumpAndSettle();

      // The fixture's projects are named atlas and atlas_private.
      expect(find.textContaining('atlas'), findsNothing);
      expect(
        find.text('Counts only · no project names · no prompt text'),
        findsOneWidget,
      );
    });

    testWidgets('the project card names them, and says that it does', (
      tester,
    ) async {
      await tester.pumpWidget(card(kind: UsageExportCardKind.projectDetail));
      await tester.pumpAndSettle();

      expect(find.text('atlas'), findsOneWidget);
      expect(
        find.text(
          'Counts + project names · no prompt text · share deliberately',
        ),
        findsOneWidget,
      );
      // And reconciles, so a shared image cannot be read as the whole picture.
      expect(find.textContaining('Grouped by repository'), findsOneWidget);
      expect(find.textContaining('unattributed'), findsOneWidget);
    });

    testWidgets('no toggle moves content across the boundary', (tester) async {
      // Cost is the only toggle, and it is green tier on both cards.
      await tester.pumpWidget(
        card(kind: UsageExportCardKind.overview, includeCost: true),
      );
      await tester.pumpAndSettle();

      expect(
        find.textContaining('at API list prices — not your bill'),
        findsOneWidget,
      );
      expect(find.textContaining('atlas'), findsNothing);
    });

    testWidgets('cost is absent unless it was asked for', (tester) async {
      await tester.pumpWidget(card(kind: UsageExportCardKind.overview));
      await tester.pumpAndSettle();

      expect(find.textContaining('API list prices'), findsNothing);
    });

    testWidgets('prompt text appears on neither card', (tester) async {
      for (final kind in UsageExportCardKind.values) {
        await tester.pumpWidget(card(kind: kind, includeCost: true));
        await tester.pumpAndSettle();
        for (final text in tester.widgetList<Text>(find.byType(Text))) {
          expect(text.data?.contains('display_name') ?? false, isFalse);
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
            // An overflow here is the failure the 640px floor exists to catch:
            // a card that does not fit is a card that ships clipped.
            expect(
              tester.takeException(),
              isNull,
              reason: '$kind $locale $brightness',
            );
          }
        }
      }
    });
  });

  testWidgets('an ordinary period renders unscaled', (tester) async {
    // Scaling exists so a dense period cannot clip, not so every card is a
    // little smaller than designed. A local size that matches the painted one
    // means the fallback stayed a fallback.
    for (final kind in UsageExportCardKind.values) {
      await tester.pumpWidget(card(kind: kind, includeCost: true));
      await tester.pumpAndSettle();

      final manifest = find.text('cosyncing · tokdash');
      final scale =
          tester.getRect(manifest).width / tester.getSize(manifest).width;
      expect(scale, closeTo(1, 0.001), reason: kind.name);
    }
  });

  testWidgets('a dense period scales down rather than clipping', (
    tester,
  ) async {
    // Five projects with long names is ordinary on a real machine and taller
    // than the frame. The card must still be 360x640 and must still contain
    // every row.
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
    final spec = themeSpecById(kDefaultThemeId);
    await tester.pumpWidget(
      MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: buildAppTheme(spec.light, Brightness.light),
        home: Center(
          child: UsageExportCard(
            kind: UsageExportCardKind.projectDetail,
            report: dense,
            machineLabel: 'This machine',
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

    // Every row is present, and the card shrank to hold them.
    for (var index = 0; index < 5; index++) {
      expect(find.text('a_rather_long_repository_name_$index'), findsOneWidget);
    }
    final manifest = find.text('cosyncing · tokdash');
    final scale =
        tester.getRect(manifest).width / tester.getSize(manifest).width;
    expect(scale, lessThan(1));
    expect(scale, greaterThan(0.7), reason: 'still legible at 3x');
  });

  group('capture', () {
    testWidgets('renders 1080 x 1920 from a 360 x 640 card', (tester) async {
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
      expect(decoded!.width, 1080);
      expect(decoded.height, 1920);
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
      expect(sink.written.first.name, endsWith('-overview-light.png'));
      expect(sink.written.last.name, endsWith('-overview-dark.png'));
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
        'cosyncing-usage-2026-08-01-2026-08-31-projects-light.png',
      );
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
  });
}
