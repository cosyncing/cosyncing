import 'dart:convert';
import 'dart:io';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_report_api.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_report_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  setUpAll(() async {
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

  for (final locale in ['en', 'es']) {
    testWidgets('$locale usage at 320px with 200% Lato has no overflow', (
      tester,
    ) async {
      tester.view
        ..physicalSize = const Size(320, 844)
        ..devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            usageNowProvider.overrideWithValue(() => DateTime(2026, 9, 2)),
            usageReportApiProvider.overrideWithValue(_ReportApi()),
          ],
          child: MaterialApp(
            locale: Locale(locale),
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
            theme: buildAppTheme(
              themeSpecById(kDefaultThemeId).light,
              Brightness.light,
            ),
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(
                context,
              ).copyWith(textScaler: const TextScaler.linear(2)),
              child: child!,
            ),
            home: const UsageReportPage(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      // Exercise the wrapped current-period control after navigating back.
      await tester.tap(find.byKey(const Key('usage-period-previous')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('usage-period-current')));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
    });
  }

  for (final variant in [
    (width: 320.0, height: 844.0, dark: false),
    (width: 390.0, height: 844.0, dark: true),
    (width: 1440.0, height: 1080.0, dark: false),
  ]) {
    testWidgets('readable report ${variant.width} ${variant.dark}', (
      tester,
    ) async {
      tester.view
        ..physicalSize = Size(variant.width, variant.height)
        ..devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final spec = themeSpecById(kDefaultThemeId);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            usageNowProvider.overrideWithValue(() => DateTime(2026, 9, 2)),
            usageReportApiProvider.overrideWithValue(_ReportApi()),
          ],
          child: MaterialApp(
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
            theme: buildAppTheme(
              variant.dark ? spec.dark : spec.light,
              variant.dark ? Brightness.dark : Brightness.light,
            ),
            home: const UsageReportPage(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await expectLater(
        find.byType(Scaffold),
        matchesGoldenFile(
          'goldens/usage_enhancement_${variant.width.toInt()}_${variant.dark ? 'dark' : 'light'}.png',
        ),
      );
    });
  }
}

class _ReportApi implements UsageReportApi {
  @override
  Future<UsageReportResponse> getReport({
    required String from,
    required String to,
  }) async => UsageReportResponse.fromJson({
    'ok': true,
    'data': jsonDecode(
      File(
        '../../contracts/generated/usage-report.sample.json',
      ).readAsStringSync(),
    ),
  });
}
