import 'dart:convert';
import 'dart:io';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_report_page.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_when_you_work.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';

Map<String, dynamic> sampleReport() =>
    jsonDecode(
          File(
            '../../contracts/generated/usage-report.sample.json',
          ).readAsStringSync(),
        )
        as Map<String, dynamic>;

void main() {
  // The label formats clock hours, which needs the locale's data loaded; a
  // widget test gets it from MaterialApp, a plain test must ask.
  setUpAll(() => initializeDateFormatting('en'));

  group('when you work', () {
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
  });
}
