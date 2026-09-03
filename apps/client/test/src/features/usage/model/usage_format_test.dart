import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_format.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('formatCompactCount', () {
    test('renders one decimal below a mantissa of 100 and none above', () {
      expect(formatCompactCount(1528566508, locale: 'en'), '1.5B');
      expect(formatCompactCount(57411256211, locale: 'en'), '57.4B');
      expect(formatCompactCount(523000, locale: 'en'), '523K');
      expect(formatCompactCount(10088964020, locale: 'en'), '10.1B');
      expect(formatCompactCount(1097438655, locale: 'en'), '1.1B');
    });

    test('a rounding carry promotes the tier instead of printing 1000', () {
      // The bug this prevents renders 999,999,999 as "1000.0M".
      expect(formatCompactCount(999999999, locale: 'en'), '1.0B');
      expect(formatCompactCount(999999, locale: 'en'), '1.0M');
      expect(formatCompactCount(999999999999, locale: 'en'), '1.0T');
    });

    test('below a thousand it is a plain grouped count', () {
      expect(formatCompactCount(0, locale: 'en'), '0');
      expect(formatCompactCount(999, locale: 'en'), '999');
      expect(formatCompactCount(1000, locale: 'en'), '1.0K');
    });

    test('negatives and non-finite values do not produce nonsense', () {
      expect(formatCompactCount(-1500000, locale: 'en'), '-1.5M');
      expect(formatCompactCount(double.nan), '');
      expect(formatCompactCount(double.infinity), '');
    });

    test('suffixes stay ASCII while digits localize', () {
      // K/M/B are used as written in every locale this app ships, so only the
      // digits and separators change.
      expect(formatCompactCount(10088964020, locale: 'zh'), '10.1B');
      expect(formatCompactCount(999, locale: 'zh'), '999');
    });
  });

  group('formatUsageCost', () {
    test('two decimals, and four below a cent so tiny is not zero', () {
      expect(formatUsageCost(899.4, locale: 'en'), r'$899.40');
      expect(formatUsageCost(8.18, locale: 'en'), r'$8.18');
      expect(formatUsageCost(0.0312, locale: 'en'), r'$0.03');
      expect(formatUsageCost(0.0004, locale: 'en'), r'$0.0004');
      expect(formatUsageCost(0, locale: 'en'), r'$0.00');
    });

    test('large figures in prose drop the cents', () {
      expect(
        formatUsageCost(12976.51, locale: 'en', compact: true),
        r'$12,977',
      );
      expect(formatUsageCost(899.4, locale: 'en', compact: true), r'$899.40');
    });
  });

  group('formatUsageHours', () {
    test('a period total reads as decimal hours, not as uptime', () {
      // formatCompactDuration would render August as "16d 19h", which reads as
      // how long something has been up rather than how long it ran.
      expect(formatUsageHours(1453366891, locale: 'en'), '403.7');
      expect(
        formatUsageHours(Duration.millisecondsPerHour, locale: 'en'),
        '1.0',
      );
    });
  });

  group('formatUsageShare', () {
    test('one decimal below 10% and none above', () {
      expect(formatUsageShare(0.0057, locale: 'en'), '0.6%');
      expect(formatUsageShare(0.1015, locale: 'en'), '10%');
      expect(formatUsageShare(0.5117, locale: 'en'), '51%');
    });
  });

  group('formatUsageDelta', () {
    test('a rise carries its sign and a fall carries its own', () {
      expect(formatUsageDelta(15.5, locale: 'en'), '+15.5%');
      expect(formatUsageDelta(-8.25, locale: 'en'), '-8.3%');
      expect(formatUsageDelta(0, locale: 'en'), '0.0%');
    });
  });

  group('UsageCoveragePercents', () {
    UsageProjectReconciliation reconcile(double named, double unattributed) {
      return UsageProjectReconciliation.of(
        UsageReportProjects(
          rows: [
            UsageReportProjectRow(
              project: 'atlas',
              tokens: named,
              cost: 0,
              requests: 0,
            ),
          ],
          namesIncluded: true,
          unattributedTokens: unattributed,
        ),
        1000000,
      )!;
    }

    test('the year-to-date split sums to exactly 100', () {
      // 89.29 + 0.57 + 10.15 rounds independently to 100.1, and a list printed
      // to prove it accounts for everything must not visibly fail to.
      final percents = UsageCoveragePercents.of(reconcile(892900, 5700));
      // Asserted in tenths: three doubles each ending in .1 sum to
      // 99.99999999999999, so the exactness claim lives on the integers.
      expect(percents.tenths.reduce((a, b) => a + b), 1000);
      expect(percents.named, 89.3);
      expect(percents.unattributed, 0.6);
      expect(percents.gap, 10.1);
    });

    test('every split sums to exactly 100, however it falls', () {
      for (var named = 0; named <= 1000000; named += 7919) {
        final unattributed = (1000000 - named) ~/ 3;
        final percents = UsageCoveragePercents.of(
          reconcile(named.toDouble(), unattributed.toDouble()),
        );
        expect(
          percents.tenths.reduce((a, b) => a + b),
          1000,
          reason: 'named=$named',
        );
        for (final part in percents.tenths) {
          expect(part, greaterThanOrEqualTo(0), reason: 'named=$named');
        }
      }
    });

    test('a fully covered period prints no gap', () {
      final percents = UsageCoveragePercents.of(reconcile(900000, 100000));
      expect(percents.named, 90.0);
      expect(percents.unattributed, 10.0);
      expect(percents.gap, 0.0);
    });

    test('each component prints one decimal so the sum reads at a glance', () {
      final percents = UsageCoveragePercents.of(reconcile(892900, 5700));
      expect(percents.format(percents.named, locale: 'en'), '89.3%');
      expect(percents.format(percents.unattributed, locale: 'en'), '0.6%');
      expect(percents.format(percents.gap, locale: 'en'), '10.1%');
    });
  });
}
