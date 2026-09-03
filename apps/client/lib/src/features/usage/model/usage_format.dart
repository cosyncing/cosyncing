/// Number formatting for the usage surfaces.
///
/// One implementation per rule, because these figures appear on four surfaces
/// and two of them are exported as images that outlive the app. A token count
/// that reads `10.1B` in Settings and `10,088,964,020` on the report is two
/// claims about one number.
library;

import 'package:broker_contract/broker_contract.dart';
import 'package:intl/intl.dart';

/// Compact count with ASCII K/M/B/T suffixes.
///
/// One decimal while the mantissa is below 100 and none above it, so a column
/// holds roughly four significant characters whatever the magnitude. Rounding
/// that carries promotes the tier: 999,999,999 renders `1.0B`, never `1000.0M`.
///
/// Digits are localized through [Intl]; the suffix is not, because K/M/B are
/// used as written in every locale this app ships.
String formatCompactCount(num value, {String? locale}) {
  if (!value.isFinite) return '';
  final magnitude = value.abs();
  if (magnitude < 1000) {
    return NumberFormat.decimalPattern(locale).format(value.round());
  }

  const tiers = <(num, String)>[
    (1000000000000, 'T'),
    (1000000000, 'B'),
    (1000000, 'M'),
    (1000, 'K'),
  ];
  for (var index = 0; index < tiers.length; index++) {
    final (divisor, suffix) = tiers[index];
    if (magnitude < divisor) continue;
    var mantissa = value / divisor;
    var decimals = mantissa.abs() < 100 ? 1 : 0;
    // A mantissa that rounds up out of its own tier belongs in the next one.
    if (mantissa.abs().toStringAsFixed(decimals) == '1000' && index > 0) {
      final (nextDivisor, nextSuffix) = tiers[index - 1];
      mantissa = value / nextDivisor;
      decimals = 1;
      return '${_fixed(mantissa, decimals, locale)}$nextSuffix';
    }
    return '${_fixed(mantissa, decimals, locale)}$suffix';
  }
  return NumberFormat.decimalPattern(locale).format(value.round());
}

String _fixed(num value, int decimals, String? locale) {
  final format = NumberFormat.decimalPatternDigits(
    locale: locale,
    decimalDigits: decimals,
  );
  return format.format(value);
}

/// API list-price equivalent, as a bare figure.
///
/// Never render the result on its own: cost is always wrapped in the qualifier
/// that says it is a list-price equivalent and not a bill. Two decimals, and
/// four below a cent so a genuinely tiny figure does not render as `$0.00`;
/// large figures in prose drop the cents.
String formatUsageCost(num cost, {String? locale, bool compact = false}) {
  if (!cost.isFinite) return '';
  if (compact && cost.abs() >= 1000) {
    return NumberFormat.currency(
      locale: locale,
      symbol: r'$',
      decimalDigits: 0,
    ).format(cost);
  }
  final decimals = cost != 0 && cost.abs() < 0.01 ? 4 : 2;
  return NumberFormat.currency(
    locale: locale,
    symbol: r'$',
    decimalDigits: decimals,
  ).format(cost);
}

/// Total agent time as decimal hours with one decimal.
///
/// A period total, not a duration: `formatCompactDuration` would render August
/// as `16d 19h`, which reads as uptime rather than as time spent.
String formatUsageHours(num milliseconds, {String? locale}) =>
    _fixed(milliseconds / Duration.millisecondsPerHour, 1, locale);

/// A share of a total, as a percentage.
///
/// One decimal below 10% and none above it: the difference between 0.6% and 1%
/// is the whole point on the project surfaces, and the difference between 51%
/// and 50.7% is noise.
String formatUsageShare(double fraction, {String? locale}) {
  if (!fraction.isFinite) return '';
  final percent = fraction * 100;
  final decimals = percent.abs() < 10 ? 1 : 0;
  return '${_fixed(percent, decimals, locale)}%';
}

/// A ranked row's figure: its count and its share of the period.
///
/// Composed here rather than in the widget so the pair stays one formatting
/// decision across the card, the report and the export cards. The separator is
/// punctuation, not copy, so it carries no localized message of its own.
String formatUsageCountWithShare(
  double count,
  double share, {
  String? locale,
}) =>
    '${formatCompactCount(count, locale: locale)}'
    ' \u00b7 ${formatUsageShare(share, locale: locale)}';

/// A whole count with locale grouping, e.g. `2,545`.
///
/// Session counts are printed in full rather than compacted: `2.5K sessions`
/// in a sentence reads as an approximation of something that was counted
/// exactly.
String formatUsageCount(num value, {String? locale}) {
  if (value is double && !value.isFinite) return '';
  return _fixed(value, 0, locale);
}

/// A one-based rank from a zero-based index, e.g. `1`.
///
/// Composed here rather than in the widget so a rank cannot pick up a
/// different notation on a different surface.
String formatUsageRank(int index, {String? locale}) =>
    _fixed(index + 1, 0, locale);

/// A one-based rank carrying its number sign, e.g. `#1`.
String formatUsageRankLabel(int index, {String? locale}) =>
    '#${formatUsageRank(index, locale: locale)}';

/// A percentage magnitude with one decimal, e.g. `15.5%`.
///
/// Separate from [formatUsageShare], which drops to whole percents above ten:
/// the hero delta and the night-owl index are quoted to a tenth in the design,
/// and rounding 15.5% to 16% would change a stated figure.
///
/// Past 100% the tenth is dropped. A first-year comparison against a window
/// that predates the user's data produces figures in the hundreds of
/// thousands of percent — a real, served number, but one where a decimal
/// place is noise rather than precision.
String formatUsagePercent(double percent, {String? locale}) {
  if (!percent.isFinite) return '';
  final magnitude = percent.abs();
  return '${_fixed(magnitude, magnitude >= 100 ? 0 : 1, locale)}%';
}

/// A signed period-over-period change, e.g. `+15.5%`.
String formatUsageDelta(double percent, {String? locale}) {
  if (!percent.isFinite) return '';
  final sign = percent > 0 ? '+' : '';
  return '$sign${_fixed(percent, 1, locale)}%';
}

/// The three coverage shares as percentages that sum to exactly 100.
///
/// Rounded independently they do not: 89.29 + 0.57 + 10.15 rounds to 89.3 +
/// 0.6 + 10.2 = 100.1, and a list printed to prove it accounts for everything
/// must not visibly fail to. Largest-remainder apportionment puts the rounding
/// slack on the component with the strongest claim to it, so the printed
/// figures are each within a tenth of the truth and their sum is exact.
class UsageCoveragePercents {
  const UsageCoveragePercents._({
    required this.namedTenths,
    required this.unattributedTenths,
    required this.gapTenths,
  });

  /// Apportions [reconciliation] into three 1-decimal percentages.
  factory UsageCoveragePercents.of(UsageProjectReconciliation reconciliation) {
    final shares = [
      reconciliation.namedShare,
      reconciliation.unattributedShare,
      reconciliation.gapShare,
    ];
    // Work in tenths of a percent, so the target is a whole 1000.
    final scaled = shares.map((share) => share * 1000).toList(growable: false);
    final floors = scaled.map((value) => value.floor()).toList();
    var remainder = 1000 - floors.reduce((a, b) => a + b);
    final order = [0, 1, 2]
      ..sort(
        (a, b) => (scaled[b] - floors[b]).compareTo(scaled[a] - floors[a]),
      );
    for (var index = 0; remainder > 0 && index < order.length; index++) {
      floors[order[index]] += 1;
      remainder -= 1;
    }
    return UsageCoveragePercents._(
      namedTenths: floors[0],
      unattributedTenths: floors[1],
      gapTenths: floors[2],
    );
  }

  /// Tenths of a percent in named project rows.
  ///
  /// Held as integers, not doubles: the guarantee is that the three sum to
  /// exactly 1000, and three doubles that each end in `.1` sum to
  /// 99.99999999999999.
  final int namedTenths;

  /// Tenths of a percent in the facet's own unattributed bucket.
  final int unattributedTenths;

  /// Tenths of a percent in no facet row at all.
  final int gapTenths;

  /// Percent of the period in named project rows.
  double get named => namedTenths / 10;

  /// Percent in the facet's own unattributed bucket.
  double get unattributed => unattributedTenths / 10;

  /// Percent in no facet row at all.
  double get gap => gapTenths / 10;

  /// The three components in tenths, which always sum to 1000.
  List<int> get tenths => [namedTenths, unattributedTenths, gapTenths];

  /// Formats one component with its percent sign.
  ///
  /// Always one decimal, including a trailing `.0`. The three are printed side
  /// by side to show they sum to 100, and mixed precision breaks that reading
  /// at a glance.
  String format(double percent, {String? locale}) =>
      '${_fixed(percent, 1, locale)}%';

  /// The three components in print order.
  List<double> get parts => [named, unattributed, gap];
}
