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

  group('formatUsageAgentTime', () {
    const hour = Duration.millisecondsPerHour;
    const day = Duration.millisecondsPerDay;

    test('below a day it is decimal hours with one decimal', () {
      expect(formatUsageAgentTime(0, locale: 'en'), '0.0 hr');
      expect(formatUsageAgentTime(0.5 * hour, locale: 'en'), '0.5 hr');
      expect(formatUsageAgentTime(5.5 * hour, locale: 'en'), '5.5 hr');
      expect(formatUsageAgentTime(23.9 * hour, locale: 'en'), '23.9 hr');
    });

    test('below a week it is days and whole hours', () {
      expect(formatUsageAgentTime(24 * hour, locale: 'en'), '1 day');
      expect(formatUsageAgentTime(25 * hour, locale: 'en'), '1 day 1 hr');
      expect(formatUsageAgentTime(3 * day, locale: 'en'), '3 days');
      expect(
        formatUsageAgentTime(6 * day + 23 * hour, locale: 'en'),
        '6 days 23 hr',
      );
    });

    test('below thirty days it is weeks and days', () {
      expect(formatUsageAgentTime(7 * day, locale: 'en'), '1 week');
      expect(formatUsageAgentTime(14 * day, locale: 'en'), '2 weeks');
      expect(formatUsageAgentTime(20 * day, locale: 'en'), '2 weeks 6 days');
      expect(formatUsageAgentTime(29 * day, locale: 'en'), '4 weeks 1 day');
    });

    test('from thirty days it is 30-day months and days', () {
      expect(formatUsageAgentTime(30 * day, locale: 'en'), '1 month');
      expect(formatUsageAgentTime(34 * day, locale: 'en'), '1 month 4 days');
      expect(formatUsageAgentTime(60 * day, locale: 'en'), '2 months');
      expect(
        formatUsageAgentTime(400 * day, locale: 'en'),
        '13 months 10 days',
      );
    });

    test('plural and singular agree in English', () {
      expect(formatUsageAgentTime(day, locale: 'en'), '1 day');
      expect(formatUsageAgentTime(2 * day, locale: 'en'), '2 days');
      expect(formatUsageAgentTime(7 * day, locale: 'en'), '1 week');
      expect(formatUsageAgentTime(30 * day, locale: 'en'), '1 month');
      expect(formatUsageAgentTime(61 * day, locale: 'en'), '2 months 1 day');
    });

    test('a concurrent-agent week can hold more than 168 hours', () {
      // activeMsSum adds across agents running at the same time: this is the
      // 267.9-hour week the decimal form misstated as a wall-clock span.
      expect(formatUsageAgentTime(267.9 * hour, locale: 'en'), '1 week 4 days');
    });

    test('units localize', () {
      expect(formatUsageAgentTime(25 * hour, locale: 'zh'), '1 天 1 小时');
      expect(formatUsageAgentTime(5.5 * hour, locale: 'zh'), '5.5 小时');
      expect(formatUsageAgentTime(20 * day, locale: 'zh'), '2 周 6 天');
      expect(formatUsageAgentTime(34 * day, locale: 'zh'), '1 个月 4 天');
    });

    test('non-finite values produce nothing', () {
      expect(formatUsageAgentTime(double.nan), '');
      expect(formatUsageAgentTime(double.infinity), '');
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

  group('formatUsageCardTokens', () {
    test('keeps the tenth at any mantissa, unlike the column rule', () {
      // tokdash's card rule: at most one decimal, dropped when it rounds to
      // none. The page's formatCompactCount would print 106M here.
      expect(formatUsageCardTokens(105500000, locale: 'en'), '105.5M');
      expect(formatUsageCardTokens(106040000, locale: 'en'), '106M');
      expect(formatUsageCardTokens(19893991786, locale: 'en'), '19.9B');
      expect(formatUsageCardTokens(1525, locale: 'en'), '1.5K');
    });

    test('a rounding carry promotes the tier instead of printing 1000', () {
      expect(formatUsageCardTokens(999999, locale: 'en'), '1M');
      expect(formatUsageCardTokens(999999999, locale: 'en'), '1B');
    });

    test('below a thousand it is a grouped integer', () {
      expect(formatUsageCardTokens(545, locale: 'en'), '545');
    });
  });

  group('formatUsageCardShare', () {
    test('two decimals under one percent, one under ten, none above', () {
      expect(formatUsageCardShare(0.0057, locale: 'en'), '0.57%');
      expect(formatUsageCardShare(0.096, locale: 'en'), '9.6%');
      expect(formatUsageCardShare(0.57, locale: 'en'), '57%');
    });

    test('a missing facet total is an em dash, never an invented zero', () {
      expect(formatUsageCardShare(null), '\u2014');
    });
  });

  group('formatUsageCardCost', () {
    test("two decimals, never compacted, tokdash's exact figure", () {
      expect(formatUsageCardCost(12976.51), r'$12976.51');
      expect(formatUsageCardCost(0.1), r'$0.10');
    });
  });

  group('formatUsageCardDuration', () {
    test('below a day it is the compact clock form', () {
      expect(formatUsageCardDuration(0), '\u2014');
      expect(formatUsageCardDuration(30000, locale: 'en'), '30s');
      expect(formatUsageCardDuration(45 * 60000, locale: 'en'), '45m');
      expect(
        formatUsageCardDuration((5 * 3600 + 5 * 60) * 1000, locale: 'en'),
        '5h 05m',
      );
    });

    test('at a day and above it is long unit words, two at most', () {
      const day = Duration.millisecondsPerDay;
      expect(
        formatUsageCardDuration(25 * 3600000, locale: 'en'),
        '1 day 1 hour',
      );
      expect(formatUsageCardDuration(3 * day, locale: 'en'), '3 days');
      expect(formatUsageCardDuration(20 * day, locale: 'en'), '2 weeks 6 days');
      expect(formatUsageCardDuration(34 * day, locale: 'en'), '1 month 4 days');
      // A 23.6h remainder rounds to a carried day, never "1 day 24 hours".
      expect(
        formatUsageCardDuration((day + 23.6 * 3600000).round(), locale: 'en'),
        '2 days',
      );
    });

    test('the joiner drops the space where the words carry none', () {
      const day = Duration.millisecondsPerDay;
      expect(
        formatUsageCardDuration(25 * 3600000, locale: 'zh'),
        '1\u59291\u5c0f\u65f6',
      );
      expect(
        formatUsageCardDuration(34 * day, locale: 'zh'),
        '1\u4e2a\u67084\u5929',
      );
    });
  });
}
