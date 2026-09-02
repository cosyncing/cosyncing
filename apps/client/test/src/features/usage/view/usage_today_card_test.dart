import 'dart:convert';
import 'dart:io';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_report_api.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_today_card.dart';
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
  final List<({String from, String to})> windows = [];

  @override
  Future<UsageReportResponse> getReport({
    required String from,
    required String to,
  }) async {
    windows.add((from: from, to: to));
    final response = this.response;
    if (response == null) {
      throw const BrokerException(message: 'unavailable', statusCode: 502);
    }
    return response;
  }
}

void main() {
  // A Wednesday: the week and month segments are genuinely part-way through.
  final wednesday = DateTime(2026, 9, 2, 9);

  UsageReportResponse served(Map<String, dynamic> data) =>
      UsageReportResponse.fromJson({'ok': true, 'data': data});

  Widget buildSubject({
    UsageReportResponse? response,
    _StubApi? api,
    Locale locale = const Locale('en'),
    Brightness brightness = Brightness.light,
    Size size = const Size(900, 1400),
  }) {
    final spec = themeSpecById(kDefaultThemeId);
    final tokens = brightness == Brightness.dark ? spec.dark : spec.light;
    return ProviderScope(
      overrides: [
        usageNowProvider.overrideWithValue(() => wednesday),
        usageReportApiProvider.overrideWithValue(api ?? _StubApi(response)),
      ],
      child: MaterialApp(
        locale: locale,
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: buildAppTheme(tokens, brightness),
        home: MediaQuery(
          data: MediaQueryData(size: size),
          child: const Scaffold(
            body: SingleChildScrollView(
              padding: EdgeInsets.all(16),
              child: UsageTodayCard(),
            ),
          ),
        ),
      ),
    );
  }

  testWidgets('the card is a sum, and says so beside the quota window', (
    tester,
  ) async {
    await tester.pumpWidget(buildSubject(response: served(sampleReport())));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('settings-usage-card')), findsOneWidget);
    expect(find.text('This machine'), findsOneWidget);
    // The one line that keeps a sum from being read as a remaining-quota
    // window, at exactly the point the two sit adjacent.
    expect(
      find.textContaining('separate from the remaining-quota windows below'),
      findsOneWidget,
    );
  });

  testWidgets('it offers today, this week and this month', (tester) async {
    await tester.pumpWidget(buildSubject(response: served(sampleReport())));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('settings-usage-period')), findsOneWidget);
    for (final label in ['Today', 'This week', 'This month']) {
      expect(find.text(label), findsOneWidget);
    }
    // The report's own period names never appear here: one vocabulary, two
    // label sets, and no segment that means something different per screen.
    expect(find.text('All time'), findsNothing);
  });

  testWidgets('switching period asks the broker for that window', (
    tester,
  ) async {
    final api = _StubApi(served(sampleReport()));
    await tester.pumpWidget(buildSubject(api: api));
    await tester.pumpAndSettle();

    expect(api.windows.single.from, '2026-09-02', reason: 'today');

    await tester.tap(find.text('This week'));
    await tester.pumpAndSettle();
    expect(api.windows.last.from, '2026-08-31', reason: 'the Monday before');

    await tester.tap(find.text('This month'));
    await tester.pumpAndSettle();
    expect(api.windows.last.from, '2026-09-01');
  });

  testWidgets('an in-progress period says how far through it is', (
    tester,
  ) async {
    final api = _StubApi(served(sampleReport()));
    await tester.pumpWidget(buildSubject(api: api));
    await tester.pumpAndSettle();

    // Today is never "in progress": it is the only day it will ever be.
    expect(find.textContaining('In progress'), findsNothing);

    await tester.tap(find.text('This week'));
    await tester.pumpAndSettle();
    expect(find.text('In progress · day 3 of 7'), findsOneWidget);
  });

  testWidgets('an unreadable card shows a notice, never a zero', (
    tester,
  ) async {
    await tester.pumpWidget(buildSubject());
    await tester.pumpAndSettle();

    expect(find.text('Usage history is unavailable.'), findsOneWidget);
    expect(find.text('Tokens'), findsNothing);
  });

  testWidgets('cost carries its qualifier here too', (tester) async {
    await tester.pumpWidget(buildSubject(response: served(sampleReport())));
    await tester.pumpAndSettle();

    expect(
      find.textContaining('at API list prices — not your bill'),
      findsOneWidget,
    );
  });

  testWidgets('rankings rank by tokens and print their shares', (tester) async {
    await tester.pumpWidget(buildSubject(response: served(sampleReport())));
    await tester.pumpAndSettle();

    expect(find.text('Top harnesses'), findsOneWidget);
    expect(find.text('Top models'), findsOneWidget);
    // The fixture's leading harness carries its tokdash label and its share.
    expect(find.text('Claude Code'), findsOneWidget);
    expect(find.textContaining('10.1B · 51%'), findsOneWidget);
  });

  testWidgets('prompt text appears nowhere in the card', (tester) async {
    await tester.pumpWidget(buildSubject(response: served(sampleReport())));
    await tester.pumpAndSettle();

    for (final text in tester.widgetList<Text>(find.byType(Text))) {
      expect(text.data?.contains('display_name') ?? false, isFalse);
    }
  });

  testWidgets('the card renders in Chinese', (tester) async {
    await tester.pumpWidget(
      buildSubject(
        response: served(sampleReport()),
        locale: const Locale('zh'),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('本机'), findsOneWidget);
    expect(find.text('今日'), findsOneWidget);
    expect(find.textContaining('非实际账单'), findsOneWidget);
  });
}
