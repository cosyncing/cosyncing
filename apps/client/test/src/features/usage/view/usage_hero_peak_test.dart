import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_hero.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:intl/date_symbol_data_local.dart';

UsageReport _report({
  List<Map<String, dynamic>>? daily,
  Map<String, dynamic>? firsts,
}) => UsageReport.fromJson({
  'range': const {'from': '2026-07-01', 'to': '2026-08-31', 'recognized': true},
  if (daily != null) 'daily': daily,
  if (firsts != null) 'firsts': firsts,
});

Map<String, dynamic> _day(String date, num tokens) => {
  'date': date,
  'tokens': tokens,
};

void main() {
  setUpAll(() async {
    await initializeDateFormatting('en');
    await initializeDateFormatting('zh');
  });

  group('usagePeakDay', () {
    test('labels the served busiest day in the requested locale', () {
      final report = _report(
        firsts: const {
          'busiestDay': '2026-08-31',
          'busiestDayTokens': 1097438655,
        },
      );
      final en = usagePeakDay(report, locale: 'en')!;
      expect(en.tokens, 1097438655);
      expect(en.label, 'Aug 31');
      expect(usagePeakDay(report, locale: 'zh')!.label, '8月31日');
    });

    test('is null when nothing served a busiest day', () {
      expect(usagePeakDay(_report()), isNull);
    });
  });

  group('usagePeakWeek', () {
    // 2026-08-01 is a Saturday, so Sunday 2026-08-02 still belongs to the
    // Monday-first week of Jul 27. The Aug 3 week carries the larger sum.
    final report = _report(
      daily: [
        _day('2026-07-28', 100),
        _day('2026-07-29', 50),
        _day('2026-08-02', 40), // Sunday: folds into the Jul 27 week (190).
        _day('2026-08-04', 300),
        _day('2026-08-05', 0), // Zero-token rows open no bucket.
      ],
    );

    test('sums Monday-first weeks and names the busiest one', () {
      final peak = usagePeakWeek(report, locale: 'en')!;
      expect(peak.tokens, 300);
      expect(peak.label, 'Aug 3');
    });

    test('honours the requested locale', () {
      // Regression: the fold used to shadow `locale`, so the tile always
      // rendered in English whatever the page's language.
      expect(usagePeakWeek(report, locale: 'zh')!.label, '8月3日');
    });

    test('is null when the window serves no daily rows', () {
      expect(usagePeakWeek(_report(), locale: 'en'), isNull);
      expect(usagePeakWeek(_report(daily: const []), locale: 'en'), isNull);
    });
  });

  group('usagePeakMonth', () {
    final report = _report(
      daily: [
        _day('2026-07-28', 100),
        _day('2026-08-04', 300),
        _day('2026-08-20', 50),
      ],
    );

    test('sums calendar months and names the busiest one', () {
      final peak = usagePeakMonth(report, locale: 'en')!;
      expect(peak.tokens, 350);
      expect(peak.label, 'August');
    });

    test('honours the requested locale', () {
      expect(usagePeakMonth(report, locale: 'zh')!.label, '八月');
    });

    test('is null when the window serves no daily rows', () {
      expect(usagePeakMonth(_report(), locale: 'en'), isNull);
    });
  });
}
