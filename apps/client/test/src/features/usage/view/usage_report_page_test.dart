import 'dart:convert';
import 'dart:io';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_report_api.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_period.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_report_page.dart';
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
    UsageReportResponse? response,
    Locale locale = const Locale('en'),
    Brightness brightness = Brightness.light,
    Size size = const Size(1000, 2400),
    Widget page = const UsageReportPage(),
  }) {
    final spec = themeSpecById(kDefaultThemeId);
    final tokens = brightness == Brightness.dark ? spec.dark : spec.light;
    return ProviderScope(
      overrides: [
        usageNowProvider.overrideWithValue(() => now),
        usageReportApiProvider.overrideWithValue(_StubApi(response)),
      ],
      child: MaterialApp(
        locale: locale,
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: buildAppTheme(tokens, brightness),
        home: MediaQuery(
          data: MediaQueryData(size: size),
          child: page,
        ),
      ),
    );
  }

  testWidgets('an unreadable report says so instead of showing zeros', (
    tester,
  ) async {
    await tester.pumpWidget(buildSubject());
    await tester.pumpAndSettle();

    expect(find.text('Usage history is unavailable.'), findsOneWidget);
    // Zero tokens and no reading are different claims, and only one is true.
    expect(find.byKey(const Key('usage-report-hero')), findsNothing);
    expect(find.textContaining('0'), findsNothing);
  });

  testWidgets('an unrecognized window renders no figure at all', (
    tester,
  ) async {
    // tokdash resolves a period it does not understand to all time, so every
    // figure would be true of a window nobody asked about.
    final data = sampleReport();
    (data['range']! as Map<String, dynamic>)['recognized'] = false;
    await tester.pumpWidget(buildSubject(response: served(data)));
    await tester.pumpAndSettle();

    // Its own notice, not the unavailable one: the report arrived, and it is
    // the period that could not be resolved. The reader's next move differs.
    expect(
      find.textContaining('tokdash did not recognize this period'),
      findsOneWidget,
    );
    expect(find.text('Usage history is unavailable.'), findsNothing);
    expect(find.byKey(const Key('usage-report-hero')), findsNothing);
    expect(find.textContaining('19.9B'), findsNothing);
  });

  testWidgets('a served report prints its scope, window and totals', (
    tester,
  ) async {
    await tester.pumpWidget(buildSubject(response: served(sampleReport())));
    await tester.pumpAndSettle();

    final hero = find.byKey(const Key('usage-report-hero'));
    expect(hero, findsOneWidget);
    expect(
      find.descendant(of: hero, matching: find.text('19.9B')),
      findsOneWidget,
    );

    // The scope is the machine, never "your cosyncing sessions": tokdash sees
    // every agent on this host and cosyncing adapts a subset.
    final scope = tester.widget<Text>(
      find.byKey(const Key('usage-report-scope')),
    );
    expect(scope.data, contains('this machine'));
    expect(scope.data, isNot(contains('cosyncing sessions')));

    // The explicit range, so a period name cannot imply more than it covers.
    expect(find.text('2026-08-01 – 2026-08-31'), findsOneWidget);
  });

  testWidgets('cost never renders without its qualifier', (tester) async {
    await tester.pumpWidget(buildSubject(response: served(sampleReport())));
    await tester.pumpAndSettle();

    // tokdash reports an API-equivalent figure, not money spent on a plan.
    expect(
      find.textContaining('at API list prices — not your bill'),
      findsWidgets,
    );
    expect(find.text(r'$12,977'), findsNothing, reason: 'never bare');
  });

  testWidgets('an empty period is empty, not unavailable', (tester) async {
    final data = sampleReport();
    data['totals'] = {'tokens': 0, 'cost': 0, 'requests': 0};
    await tester.pumpWidget(buildSubject(response: served(data)));
    await tester.pumpAndSettle();

    expect(find.textContaining('No activity recorded'), findsOneWidget);
    expect(find.text('Usage history is unavailable.'), findsNothing);
  });

  testWidgets('a partial read names the tools it could not include', (
    tester,
  ) async {
    final data = sampleReport();
    data['sourceErrors'] = ['kimi', 'grok'];
    await tester.pumpWidget(buildSubject(response: served(data)));
    await tester.pumpAndSettle();

    expect(find.textContaining('kimi, grok'), findsOneWidget);
    // A short total is still a total: the report renders beside the warning.
    expect(find.byKey(const Key('usage-report-hero')), findsOneWidget);
  });

  testWidgets('the period switcher offers the four report periods', (
    tester,
  ) async {
    await tester.pumpWidget(buildSubject(response: served(sampleReport())));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('usage-period-switcher')), findsOneWidget);
    for (final label in ['Week', 'Month', 'Year', 'All time']) {
      expect(find.text(label), findsOneWidget);
    }
  });

  testWidgets('the footer cites the served source count, not a constant', (
    tester,
  ) async {
    await tester.pumpWidget(buildSubject(response: served(sampleReport())));
    await tester.pumpAndSettle();

    expect(find.textContaining('5 tool sources'), findsOneWidget);
  });

  testWidgets('prompt text appears nowhere in the widget tree', (tester) async {
    // The broker drops display_name, and this asserts the client never
    // reintroduces it from some other field.
    await tester.pumpWidget(buildSubject(response: served(sampleReport())));
    await tester.pumpAndSettle();

    for (final text in tester.widgetList<Text>(find.byType(Text))) {
      final data = text.data;
      if (data == null) continue;
      expect(data.contains('display_name'), isFalse, reason: data);
    }
  });

  testWidgets('the report renders in Chinese with the same figures', (
    tester,
  ) async {
    await tester.pumpWidget(
      buildSubject(
        response: served(sampleReport()),
        locale: const Locale('zh'),
      ),
    );
    await tester.pumpAndSettle();

    expect(
      find.descendant(
        of: find.byKey(const Key('usage-report-hero')),
        matching: find.text('19.9B'),
      ),
      findsOneWidget,
    );
    // The qualifier appears wherever a cost does — the sentence, the podium
    // tile, the footer — and never once without one.
    expect(find.textContaining('非实际账单'), findsWidgets);
    // The export cards carry their own scope line, so this asserts the page's.
    final scope = tester.widget<Text>(
      find.byKey(const Key('usage-report-scope')),
    );
    expect(scope.data, contains('本机全部 agent 活动'));
  });

  testWidgets('the page opens on the period a link names', (tester) async {
    await tester.pumpWidget(
      buildSubject(
        response: served(sampleReport()),
        page: const UsageReportPage(initialPeriod: UsagePeriod.year),
      ),
    );
    await tester.pumpAndSettle();

    // A month-end notification opens on the period it is about, rather than on
    // whatever the page's default happens to be.
    expect(
      find.descendant(
        of: find.byKey(const Key('usage-period-switcher')),
        matching: find.text('Year'),
      ),
      findsOneWidget,
    );
    expect(find.textContaining('2026'), findsWidgets);
  });

  testWidgets('no link period leaves the default alone', (tester) async {
    await tester.pumpWidget(buildSubject(response: served(sampleReport())));
    await tester.pumpAndSettle();

    expect(find.textContaining('August 2026'), findsWidgets);
  });
}
