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

  testWidgets('the card is a sum, and its heading is what says so', (
    tester,
  ) async {
    await tester.pumpWidget(buildSubject(response: served(sampleReport())));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('settings-usage-card')), findsOneWidget);
    expect(find.text('This machine'), findsOneWidget);
    // A sentence used to sit here explaining that these totals are not the
    // remaining-quota windows below. Two headings set at two weights carry
    // that break on their own, and the prose only added a line to read.
    expect(
      find.textContaining('separate from the remaining-quota windows below'),
      findsNothing,
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

  testWidgets('an old tokdash is named as old, not as a refused period', (
    tester,
  ) async {
    // The measured macOS host: tokdash 2.0.0 answers correct totals for the
    // requested window and publishes no `recognized` field, so the card used to
    // print "Usage history is unavailable" — which is false twice over.
    final data = sampleReport()
      ..['runtime'] = <String, dynamic>{
        'version': '2.0.0',
        'minimumVersion': '2.5.0',
        'belowMinimum': true,
      }
      ..['range'] = <String, dynamic>{
        'from': '2026-08-01',
        'to': '2026-08-31',
        'recognized': false,
      };
    await tester.pumpWidget(buildSubject(response: served(data)));
    await tester.pumpAndSettle();

    expect(find.textContaining('tokdash 2.0.0'), findsOneWidget);
    expect(find.textContaining('2.5.0 or later'), findsOneWidget);
    expect(find.textContaining('pipx upgrade tokdash'), findsOneWidget);
    expect(find.text('Usage history is unavailable.'), findsNothing);
    expect(find.textContaining('did not recognize this period'), findsNothing);
  });

  testWidgets('a tokdash that will not name itself still says upgrade', (
    tester,
  ) async {
    final data = sampleReport()
      ..['runtime'] = <String, dynamic>{
        'version': null,
        'minimumVersion': '2.5.0',
        'belowMinimum': true,
      };
    await tester.pumpWidget(buildSubject(response: served(data)));
    await tester.pumpAndSettle();

    expect(find.textContaining('does not report its version'), findsOneWidget);
    // Never a rendered null where a version would be.
    for (final text in tester.widgetList<SelectableText>(
      find.byType(SelectableText),
    )) {
      expect(text.data?.contains('null') ?? false, isFalse);
    }
  });

  testWidgets('a current tokdash that refuses the period keeps that message', (
    tester,
  ) async {
    final data = sampleReport()
      ..['range'] = <String, dynamic>{
        'from': '2026-08-01',
        'to': '2026-08-31',
        'recognized': false,
      };
    await tester.pumpWidget(buildSubject(response: served(data)));
    await tester.pumpAndSettle();

    expect(
      find.textContaining('did not recognize this period'),
      findsOneWidget,
    );
    expect(find.textContaining('pipx upgrade tokdash'), findsNothing);
  });

  testWidgets('a notice can be selected and copied', (tester) async {
    // Every notice in the app says something worth pasting into a bug report —
    // a version, a command, a tool that could not be read — and a plain Text
    // cannot be copied at all in the web client, which is where these are read.
    await tester.pumpWidget(buildSubject());
    await tester.pumpAndSettle();

    expect(
      find.byWidgetPredicate(
        (widget) =>
            widget is SelectableText &&
            widget.data == 'Usage history is unavailable.',
      ),
      findsOneWidget,
      reason: 'InlineNotice renders its text as SelectableText',
    );
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
