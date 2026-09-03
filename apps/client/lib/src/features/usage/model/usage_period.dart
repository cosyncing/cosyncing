/// Periods the usage surfaces can ask the broker for, and how each resolves to
/// a date window.
///
/// One vocabulary for both surfaces. The Today card offers today/week/month and
/// the report page offers week/month/year/all time, but they are the same
/// periods resolved the same way, so a figure cannot mean one thing in Settings
/// and another on the report.
library;

/// A period the report can be asked for.
enum UsagePeriod {
  /// The current day.
  today,

  /// The ISO week in progress, Monday-first.
  week,

  /// The calendar month in progress.
  month,

  /// The calendar year in progress.
  year,

  /// Everything the broker host has recorded.
  allTime;

  /// The periods the Today card offers, in display order.
  static const List<UsagePeriod> todayCard = [
    UsagePeriod.today,
    UsagePeriod.week,
    UsagePeriod.month,
  ];

  /// The periods the report page offers, in display order.
  static const List<UsagePeriod> report = [
    UsagePeriod.week,
    UsagePeriod.month,
    UsagePeriod.year,
    UsagePeriod.allTime,
  ];
}

/// The `?period=` name for a period, and back again.
///
/// A stable link vocabulary, deliberately not `UsagePeriod.name`: the enum is
/// free to be renamed, and a link that shipped in a notification is not.
extension UsagePeriodLink on UsagePeriod {
  /// The name this period carries in a link.
  String get linkName => switch (this) {
    UsagePeriod.today => 'today',
    UsagePeriod.week => 'week',
    UsagePeriod.month => 'month',
    UsagePeriod.year => 'year',
    UsagePeriod.allTime => 'all-time',
  };

  /// Reads a link name, or `null` for anything the report does not offer.
  ///
  /// `today` parses to `null` deliberately: it is a Today-card period, and the
  /// report's switcher has no seat for it.
  static UsagePeriod? parse(String? value) {
    if (value == null) return null;
    for (final period in UsagePeriod.report) {
      if (period.linkName == value) return period;
    }
    return null;
  }
}

/// The earliest day an all-time window reaches back to.
///
/// Tokdash bounds the answer by what it actually recorded — a 244-day window
/// came back with 230 day rows, not 244 — so a wide floor costs range, not
/// payload. It is deliberately far enough back to predate any agent history
/// rather than being a guess at when this user started.
const String usageAllTimeFloor = '2000-01-01';

/// One resolved date window, plus what the UI needs to label it honestly.
class UsageWindow {
  /// Creates a window.
  const UsageWindow({
    required this.period,
    required this.from,
    required this.to,
    required this.elapsedDays,
    required this.totalDays,
  });

  /// The period this window resolves.
  final UsagePeriod period;

  /// Inclusive first day, `YYYY-MM-DD`.
  final String from;

  /// Inclusive last day, `YYYY-MM-DD`.
  final String to;

  /// Days of the period that have already happened, including today.
  final int elapsedDays;

  /// Days the period will contain once complete, or `null` when unbounded.
  ///
  /// `null` for all time, which has no length to be part-way through.
  final int? totalDays;

  /// Whether the period is still running, so its totals are not yet final.
  ///
  /// Drives the "in progress · day 2 of 7" note. Without it a half-finished
  /// week reads as a whole one and its comparison looks like a collapse.
  bool get inProgress {
    final total = totalDays;
    return total != null && elapsedDays < total;
  }
}

String _iso(DateTime date) {
  final month = date.month.toString().padLeft(2, '0');
  final day = date.day.toString().padLeft(2, '0');
  return '${date.year}-$month-$day';
}

// Every date calculation below runs on UTC-midnight instants, never on local
// ones. Local DateTime arithmetic silently loses a day across a daylight-saving
// transition: on this host Jan 1 to Sep 2 measures 244 days and 23 hours, so
// `.inDays` truncates day-of-year 245 to 244, and March measures 30 days long.
// Anchoring to UTC removes the transition rather than compensating for it, and
// the calendar fields are identical either way.
int _daysInMonth(int year, int month) => DateTime.utc(
  year,
  month + 1,
).difference(DateTime.utc(year, month)).inDays;

int _daysInYear(int year) =>
    DateTime.utc(year + 1).difference(DateTime.utc(year)).inDays;

/// Resolves [period] against [now], which is the client's local date.
///
/// Days begin at the broker host's local midnight, and the client may be in a
/// different zone, so a window computed here can be a day off from the broker's
/// idea of "today". That is why the report labels its window from the served
/// `range` block and prints the broker's zone rather than trusting this
/// resolution to be the last word.
UsageWindow resolveUsageWindow(UsagePeriod period, DateTime now) {
  final today = DateTime.utc(now.year, now.month, now.day);
  switch (period) {
    case UsagePeriod.today:
      return UsageWindow(
        period: period,
        from: _iso(today),
        to: _iso(today),
        elapsedDays: 1,
        totalDays: 1,
      );
    case UsagePeriod.week:
      // DateTime.weekday is 1..7 Monday-first, matching Tokdash's own buckets.
      final start = today.subtract(Duration(days: today.weekday - 1));
      return UsageWindow(
        period: period,
        from: _iso(start),
        to: _iso(today),
        elapsedDays: today.weekday,
        totalDays: 7,
      );
    case UsagePeriod.month:
      return UsageWindow(
        period: period,
        from: _iso(DateTime.utc(today.year, today.month)),
        to: _iso(today),
        elapsedDays: today.day,
        totalDays: _daysInMonth(today.year, today.month),
      );
    case UsagePeriod.year:
      final start = DateTime.utc(today.year);
      return UsageWindow(
        period: period,
        from: _iso(start),
        to: _iso(today),
        elapsedDays: today.difference(start).inDays + 1,
        totalDays: _daysInYear(today.year),
      );
    case UsagePeriod.allTime:
      return UsageWindow(
        period: period,
        from: usageAllTimeFloor,
        to: _iso(today),
        elapsedDays: 0,
        totalDays: null,
      );
  }
}
