import 'dart:convert';
import 'dart:io';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_export_service.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_report_api.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_export_card.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_report_page.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_today_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// Golden evidence for the usage surfaces.
///
/// Sampled the way the existing families are, on a diagonal through
/// brightness × locale × width rather than as a full cross-product: a
/// regression in any of those axes shows up in at least one image, and the
/// binaries stay countable.
Map<String, dynamic> sampleReport() =>
    jsonDecode(
          File(
            '../../contracts/generated/usage-report.sample.json',
          ).readAsStringSync(),
        )
        as Map<String, dynamic>;

class _StubApi implements UsageReportApi {
  _StubApi(this.data);

  final Map<String, dynamic>? data;

  @override
  Future<UsageReportResponse> getReport({
    required String from,
    required String to,
  }) async {
    final data = this.data;
    if (data == null) {
      throw const BrokerException(message: 'unavailable', statusCode: 502);
    }
    return UsageReportResponse.fromJson({'ok': true, 'data': data});
  }
}

void main() {
  final now = DateTime(2026, 9, 2, 9);

  Widget subject({
    required Widget child,
    required Locale locale,
    required Brightness brightness,
    Map<String, dynamic>? data,
  }) {
    final spec = themeSpecById(kDefaultThemeId);
    final tokens = brightness == Brightness.dark ? spec.dark : spec.light;
    return ProviderScope(
      overrides: [
        usageNowProvider.overrideWithValue(() => now),
        usageReportApiProvider.overrideWithValue(_StubApi(data)),
        // A golden must not depend on a rasterizer running inside a golden.
        usageExportCaptureProvider.overrideWithValue((key) async => null),
      ],
      child: MaterialApp(
        locale: locale,
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: buildAppTheme(tokens, brightness),
        home: child,
      ),
    );
  }

  Future<void> pumpGolden(
    WidgetTester tester, {
    required String name,
    required Widget child,
    required Size size,
    Locale locale = const Locale('en'),
    Brightness brightness = Brightness.light,
    Map<String, dynamic>? data,
  }) async {
    tester.view
      ..physicalSize = size
      ..devicePixelRatio = 1;
    addTearDown(() {
      tester.view
        ..resetPhysicalSize()
        ..resetDevicePixelRatio();
    });
    await tester.pumpWidget(
      subject(
        child: child,
        locale: locale,
        brightness: brightness,
        data: data,
      ),
    );
    await tester.pumpAndSettle();
    await expectLater(
      find.byType(Scaffold),
      matchesGoldenFile('goldens/$name.png'),
    );
  }

  Widget card() => const Scaffold(
    body: SingleChildScrollView(
      padding: EdgeInsets.all(16),
      child: UsageTodayCard(),
    ),
  );

  group('today card', () {
    testWidgets('light, compact, en', (tester) async {
      await pumpGolden(
        tester,
        name: 'usage_card_light_compact_en',
        child: card(),
        size: const Size(420, 900),
        data: sampleReport(),
      );
    });

    testWidgets('dark, roomy, zh', (tester) async {
      await pumpGolden(
        tester,
        name: 'usage_card_dark_roomy_zh',
        child: card(),
        size: const Size(900, 900),
        locale: const Locale('zh'),
        brightness: Brightness.dark,
        data: sampleReport(),
      );
    });

    testWidgets('unavailable, dark, compact, en', (tester) async {
      await pumpGolden(
        tester,
        name: 'usage_card_unavailable_dark_compact_en',
        child: card(),
        size: const Size(420, 600),
        brightness: Brightness.dark,
      );
    });
  });

  group('report page', () {
    testWidgets('light, roomy, en', (tester) async {
      await pumpGolden(
        tester,
        name: 'usage_report_light_roomy_en',
        child: const UsageReportPage(),
        size: const Size(1000, 2600),
        data: sampleReport(),
      );
    });

    testWidgets('dark, compact, zh', (tester) async {
      await pumpGolden(
        tester,
        name: 'usage_report_dark_compact_zh',
        child: const UsageReportPage(),
        size: const Size(420, 2800),
        locale: const Locale('zh'),
        brightness: Brightness.dark,
        data: sampleReport(),
      );
    });

    testWidgets('medium width, light, zh', (tester) async {
      await pumpGolden(
        tester,
        name: 'usage_report_light_medium_zh',
        child: const UsageReportPage(),
        size: const Size(720, 2700),
        locale: const Locale('zh'),
        data: sampleReport(),
      );
    });
  });

  group('report states', () {
    testWidgets('unavailable, light, en', (tester) async {
      await pumpGolden(
        tester,
        name: 'usage_report_unavailable_light_en',
        child: const UsageReportPage(),
        size: const Size(720, 520),
      );
    });

    testWidgets('empty period, dark, zh', (tester) async {
      final data = sampleReport();
      data['totals'] = {'tokens': 0, 'cost': 0, 'requests': 0};
      await pumpGolden(
        tester,
        name: 'usage_report_empty_dark_zh',
        child: const UsageReportPage(),
        size: const Size(720, 620),
        locale: const Locale('zh'),
        brightness: Brightness.dark,
        data: data,
      );
    });

    testWidgets('partial read, light, en', (tester) async {
      final data = sampleReport()..['sourceErrors'] = ['kimi', 'grok'];
      await pumpGolden(
        tester,
        name: 'usage_report_partial_light_en',
        child: const UsageReportPage(),
        size: const Size(1000, 2700),
        data: data,
      );
    });

    testWidgets('insights facets absent, dark, en', (tester) async {
      final data = sampleReport()
        ..remove('hourly')
        ..remove('weekday')
        ..['insightsUnavailable'] = 'unsupported';
      await pumpGolden(
        tester,
        name: 'usage_report_no_insights_dark_en',
        child: const UsageReportPage(),
        size: const Size(1000, 2400),
        brightness: Brightness.dark,
        data: data,
      );
    });
  });

  group('export cards', () {
    Widget exportCard(UsageExportCardKind kind, Locale locale) {
      final report = UsageReportResponse.fromJson({
        'ok': true,
        'data': sampleReport(),
      }).report!;
      return Scaffold(
        body: Center(
          child: UsageExportCard(
            kind: kind,
            report: report,
            machineLabel: locale.languageCode == 'zh' ? '本机' : 'This machine',
            locale: locale.toLanguageTag(),
            includeCost: true,
          ),
        ),
      );
    }

    testWidgets('overview, light, en', (tester) async {
      await pumpGolden(
        tester,
        name: 'usage_export_overview_light_en',
        child: exportCard(UsageExportCardKind.overview, const Locale('en')),
        size: const Size(500, 760),
      );
    });

    testWidgets('overview, dark, zh', (tester) async {
      await pumpGolden(
        tester,
        name: 'usage_export_overview_dark_zh',
        child: exportCard(UsageExportCardKind.overview, const Locale('zh')),
        size: const Size(500, 760),
        locale: const Locale('zh'),
        brightness: Brightness.dark,
      );
    });

    testWidgets('project detail, dark, en', (tester) async {
      await pumpGolden(
        tester,
        name: 'usage_export_projects_dark_en',
        child: exportCard(
          UsageExportCardKind.projectDetail,
          const Locale('en'),
        ),
        size: const Size(500, 760),
        brightness: Brightness.dark,
      );
    });

    testWidgets('project detail, light, zh', (tester) async {
      await pumpGolden(
        tester,
        name: 'usage_export_projects_light_zh',
        child: exportCard(
          UsageExportCardKind.projectDetail,
          const Locale('zh'),
        ),
        size: const Size(500, 760),
        locale: const Locale('zh'),
      );
    });
  });
}
