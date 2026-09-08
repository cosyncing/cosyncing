import 'package:cosyncing_client/src/features/usage/model/usage_period.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  // A Wednesday, so the week window is genuinely part-way through and a
  // Monday-first start is distinguishable from a Sunday-first one.
  final wednesday = DateTime(2026, 9, 2, 14, 30);

  group('resolveUsageWindow', () {
    test('today is a single day and is never in progress', () {
      final window = resolveUsageWindow(UsagePeriod.today, wednesday);
      expect(window.from, '2026-09-02');
      expect(window.to, '2026-09-02');
      expect(window.elapsedDays, 1);
      expect(window.totalDays, 1);
      // A day in progress is still the only day it will ever be, so the card
      // has no "day 1 of 1" note to print.
      expect(window.inProgress, isFalse);
    });

    test('the week starts on Monday, matching tokdash own buckets', () {
      final window = resolveUsageWindow(UsagePeriod.week, wednesday);
      expect(window.from, '2026-08-31', reason: 'the Monday before');
      expect(window.to, '2026-09-02');
      expect(window.elapsedDays, 3);
      expect(window.totalDays, 7);
      expect(window.inProgress, isTrue);
    });

    test('a Sunday closes the week rather than opening the next one', () {
      final sunday = DateTime(2026, 9, 6);
      final window = resolveUsageWindow(UsagePeriod.week, sunday);
      expect(window.from, '2026-08-31');
      expect(window.to, '2026-09-06');
      expect(window.elapsedDays, 7);
      expect(window.inProgress, isFalse);
    });

    test('the month runs from the first to today', () {
      final window = resolveUsageWindow(UsagePeriod.month, wednesday);
      expect(window.from, '2026-09-01');
      expect(window.to, '2026-09-02');
      expect(window.elapsedDays, 2);
      expect(window.totalDays, 30, reason: 'September');
      expect(window.inProgress, isTrue);
    });

    test('February knows about leap years', () {
      expect(
        resolveUsageWindow(UsagePeriod.month, DateTime(2028, 2, 10)).totalDays,
        29,
      );
      expect(
        resolveUsageWindow(UsagePeriod.month, DateTime(2026, 2, 10)).totalDays,
        28,
      );
    });

    test('a complete month is not in progress', () {
      final window = resolveUsageWindow(
        UsagePeriod.month,
        DateTime(2026, 8, 31),
      );
      expect(window.elapsedDays, 31);
      expect(window.totalDays, 31);
      expect(window.inProgress, isFalse);
    });

    test('the year runs from January 1 to today', () {
      final window = resolveUsageWindow(UsagePeriod.year, wednesday);
      expect(window.from, '2026-01-01');
      expect(window.to, '2026-09-02');
      expect(window.elapsedDays, 245, reason: 'Jan 1 is day 1');
      expect(window.totalDays, 365);
      expect(window.inProgress, isTrue);
    });

    test('the year knows about leap years', () {
      expect(
        resolveUsageWindow(UsagePeriod.year, DateTime(2028, 3)).totalDays,
        366,
      );
    });

    test('all time reaches back past any agent history and has no length', () {
      final window = resolveUsageWindow(UsagePeriod.allTime, wednesday);
      expect(window.from, usageAllTimeFloor);
      expect(window.to, '2026-09-02');
      // No length means nothing to be part-way through, so no in-progress note
      // and no "230 of 9,700 days active" absurdity.
      expect(window.totalDays, isNull);
      expect(window.inProgress, isFalse);
    });

    test('every window is a well-formed, ordered YYYY-MM-DD pair', () {
      final iso = RegExp(r'^\d{4}-\d{2}-\d{2}$');
      for (final period in UsagePeriod.values) {
        final window = resolveUsageWindow(period, wednesday);
        expect(iso.hasMatch(window.from), isTrue, reason: '$period from');
        expect(iso.hasMatch(window.to), isTrue, reason: '$period to');
        expect(
          window.from.compareTo(window.to) <= 0,
          isTrue,
          reason: '$period must not invert; the broker refuses that',
        );
      }
    });

    test('a single-digit month and day are zero-padded', () {
      final window = resolveUsageWindow(
        UsagePeriod.today,
        DateTime(2026, 1, 5),
      );
      expect(window.from, '2026-01-05');
    });

    test('the two surfaces offer periods from one vocabulary', () {
      expect(UsagePeriod.todayCard, [
        UsagePeriod.today,
        UsagePeriod.week,
        UsagePeriod.month,
      ]);
      expect(UsagePeriod.report, [
        UsagePeriod.week,
        UsagePeriod.month,
        UsagePeriod.year,
        UsagePeriod.allTime,
      ]);
      // Week and month appear on both, and must resolve identically there.
      for (final period in [UsagePeriod.week, UsagePeriod.month]) {
        final window = resolveUsageWindow(period, wednesday);
        expect(UsagePeriod.todayCard, contains(period));
        expect(UsagePeriod.report, contains(period));
        expect(window.from, resolveUsageWindow(period, wednesday).from);
      }
    });
  });

  group('resolveUsageWindow with an offset', () {
    test('offset zero is the current behavior, unchanged', () {
      for (final period in UsagePeriod.values) {
        final plain = resolveUsageWindow(period, wednesday);
        // The explicit zero is the subject: it must equal the defaulted call.
        // ignore: avoid_redundant_argument_values
        final explicit = resolveUsageWindow(period, wednesday, offset: 0);
        expect(explicit.from, plain.from);
        expect(explicit.to, plain.to);
        expect(explicit.elapsedDays, plain.elapsedDays);
        expect(explicit.totalDays, plain.totalDays);
      }
    });

    test('the previous week is the complete Monday-first week before', () {
      // The Wednesday fixture sits in the week that opened August 31, so one
      // step back lands across the month boundary.
      final window = resolveUsageWindow(UsagePeriod.week, wednesday, offset: 1);
      expect(window.from, '2026-08-24');
      expect(window.to, '2026-08-30');
      expect(window.elapsedDays, 7);
      expect(window.totalDays, 7);
      expect(window.inProgress, isFalse);
    });

    test('two steps back lands two complete weeks back', () {
      final window = resolveUsageWindow(UsagePeriod.week, wednesday, offset: 2);
      expect(window.from, '2026-08-17');
      expect(window.to, '2026-08-23');
    });

    test('a week stepped from Monday closes the week just ended', () {
      final monday = DateTime(2026, 9, 7);
      final window = resolveUsageWindow(UsagePeriod.week, monday, offset: 1);
      expect(window.from, '2026-08-31');
      expect(window.to, '2026-09-06');
      expect(window.inProgress, isFalse);
    });

    test(
      'the previous month is the whole calendar month, by its own length',
      () {
        final window = resolveUsageWindow(
          UsagePeriod.month,
          wednesday,
          offset: 1,
        );
        expect(window.from, '2026-08-01');
        expect(window.to, '2026-08-31');
        expect(window.elapsedDays, 31);
        expect(window.totalDays, 31);
        expect(window.inProgress, isFalse);
      },
    );

    test('March steps back to February, leap year or not', () {
      final leap = resolveUsageWindow(
        UsagePeriod.month,
        DateTime(2028, 3, 15),
        offset: 1,
      );
      expect((leap.from, leap.to), ('2028-02-01', '2028-02-29'));
      expect(leap.inProgress, isFalse);
      final plain = resolveUsageWindow(
        UsagePeriod.month,
        DateTime(2026, 3, 15),
        offset: 1,
      );
      expect((plain.from, plain.to), ('2026-02-01', '2026-02-28'));
    });

    test('January steps back across the year boundary', () {
      final window = resolveUsageWindow(
        UsagePeriod.month,
        DateTime(2027, 1, 10),
        offset: 1,
      );
      expect((window.from, window.to), ('2026-12-01', '2026-12-31'));
      final thirteen = resolveUsageWindow(
        UsagePeriod.month,
        DateTime(2027, 1, 10),
        offset: 13,
      );
      expect((thirteen.from, thirteen.to), ('2025-12-01', '2025-12-31'));
    });

    test('the previous year is complete, leap years included', () {
      final window = resolveUsageWindow(UsagePeriod.year, wednesday, offset: 1);
      expect((window.from, window.to), ('2025-01-01', '2025-12-31'));
      expect(window.elapsedDays, 365);
      expect(window.totalDays, 365);
      expect(window.inProgress, isFalse);
      final leap = resolveUsageWindow(
        UsagePeriod.year,
        DateTime(2029, 6),
        offset: 1,
      );
      expect((leap.from, leap.to), ('2028-01-01', '2028-12-31'));
      expect(leap.totalDays, 366);
    });

    test('today and all time have no previous window to step into', () {
      expect(
        () => resolveUsageWindow(UsagePeriod.today, wednesday, offset: 1),
        throwsArgumentError,
      );
      expect(
        () => resolveUsageWindow(UsagePeriod.allTime, wednesday, offset: 1),
        throwsArgumentError,
      );
      expect(
        () => resolveUsageWindow(UsagePeriod.week, wednesday, offset: -1),
        throwsRangeError,
      );
    });
  });

  group('link names', () {
    test('every report period round-trips through its link name', () {
      for (final period in UsagePeriod.report) {
        expect(UsagePeriodLink.parse(period.linkName), period);
      }
    });

    test('the names are the stable vocabulary, not the enum spelling', () {
      // A link that shipped in a notification outlives any rename here.
      expect(UsagePeriod.allTime.linkName, 'all-time');
      expect(UsagePeriod.month.linkName, 'month');
    });

    test('a period the report does not offer parses to nothing', () {
      // `today` is a Today-card period; the report switcher has no seat for it,
      // so a link naming it opens on the default rather than on a missing tab.
      expect(UsagePeriodLink.parse('today'), isNull);
      expect(UsagePeriodLink.parse('fortnight'), isNull);
      expect(UsagePeriodLink.parse(null), isNull);
      expect(UsagePeriodLink.parse(''), isNull);
    });
  });
}
