/// Number formatting for the usage surfaces.
///
/// One implementation per rule, because these figures appear on four surfaces
/// and two of them are exported as images that outlive the app. A token count
/// that reads `10.1B` in Settings and `10,088,964,020` on the report is two
/// claims about one number.
library;

import 'dart:ui' as ui;

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
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

/// Total agent time, normalized to at most two units.
///
/// A period total, not a duration, but decimal hours (`267.9h`) read as one
/// continuous span once they pass a day, so the total is stated in the largest
/// unit that fits: decimal hours below a day (`5.5 hr`), days and whole hours
/// below a week (`1 day 1 hr`), weeks and days below thirty days (`2 weeks 6
/// days`), then 30-day months and days (`1 month 4 days`). A zero remainder is
/// dropped (`3 days`). The figure is a sum across agents running at the same
/// time — a week can hold more than 168 — so the units name an amount of work,
/// never a span of wall-clock time.
String formatUsageAgentTime(num milliseconds, {String? locale}) {
  if (!milliseconds.isFinite) return '';
  final l10n = lookupAppLocalizations(_appLocale(locale));
  const msPerHour = Duration.millisecondsPerHour;
  const msPerDay = Duration.millisecondsPerDay;
  final totalHours = milliseconds / msPerHour;
  if (totalHours < 24) {
    return l10n.usageAgentTimeHours(_fixed(totalHours, 1, locale));
  }
  final totalDays = milliseconds.floor() ~/ msPerDay;
  if (totalDays < 7) {
    final hours = ((milliseconds - totalDays * msPerDay) / msPerHour).floor();
    final days = l10n.usageAgentTimeDays(totalDays);
    return hours == 0 ? days : '$days ${l10n.usageAgentTimeHours('$hours')}';
  }
  if (totalDays < 30) {
    final weeks = l10n.usageAgentTimeWeeks(totalDays ~/ 7);
    final days = totalDays % 7;
    return days == 0 ? weeks : '$weeks ${l10n.usageAgentTimeDays(days)}';
  }
  final months = l10n.usageAgentTimeMonths(totalDays ~/ 30);
  final days = totalDays % 30;
  return days == 0 ? months : '$months ${l10n.usageAgentTimeDays(days)}';
}

/// Resolves a BCP-47 tag to the locale the generated messages are keyed by.
///
/// The app ships language-only locales, so the language code is the whole
/// match; a tag this app does not ship falls back to English, the same answer
/// the delegates give.
ui.Locale _appLocale(String? locale) {
  if (locale == null || locale.isEmpty) return const ui.Locale('en');
  return ui.Locale(locale.split('-').first.split('_').first);
}

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

/// Compact count under tokdash's card rule: at most one decimal at any
/// magnitude, with the decimal dropped when it rounds to none.
///
/// [formatCompactCount] goes to zero decimals at a 100+ mantissa to hold a
/// column to four significant characters; the export card is a poster, not a
/// column, so `105.5M` keeps its tenth. Rounding that carries promotes the
/// tier, as it does there.
String formatUsageCardTokens(num value, {String? locale}) {
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
  var index = tiers.indexWhere((tier) => magnitude >= tier.$1);
  if (index < 0) index = tiers.length - 1;
  var (divisor, suffix) = tiers[index];
  var mantissa = (value / divisor * 10).round() / 10;
  if (mantissa.abs() >= 1000 && index > 0) {
    (divisor, suffix) = tiers[index - 1];
    mantissa = (value / divisor * 10).round() / 10;
  }
  final decimals = mantissa == mantissa.roundToDouble() ? 0 : 1;
  return '${_fixed(mantissa, decimals, locale)}$suffix';
}

/// A ranked row's share under tokdash's card rule.
///
/// Two decimals while under 1% (`0.57%` is the whole point on a shared
/// image), one below 10%, none above. A missing facet total is an em dash,
/// never an invented zero.
String formatUsageCardShare(double? fraction, {String? locale}) {
  if (fraction == null || !fraction.isFinite) return '\u2014';
  final percent = fraction * 100;
  final decimals = percent > 0 && percent < 1
      ? 2
      : percent < 10
      ? 1
      : 0;
  return '${_fixed(percent, decimals, locale)}%';
}

/// API list-price equivalent on the card: two decimals, never compacted.
///
/// tokdash's card prints `'$' + n.toFixed(2)` — no locale grouping and no
/// cents-dropping at four digits — so the card and the reference render the
/// same figure byte for byte. The qualifier rides on the page's toggle, not
/// beside the number.
String formatUsageCardCost(num cost) {
  if (!cost.isFinite) return '';
  return '\$${cost.toStringAsFixed(2)}';
}

/// Total agent time on the card, under tokdash's duration rule.
///
/// Below a day this is the compact clock form (`5h 05m`, `45m`, `30s`); at a
/// day and above it switches to long unit words, two units at most: day+hour
/// below a week, week+day below thirty days, then 30-day months and days. The
/// joiner drops the space where the locale's words carry none (`1天1小时`).
/// Distinct from [formatUsageAgentTime], the page's decimal-hours style,
/// because the card is a tokdash port and the page is not.
String formatUsageCardDuration(num milliseconds, {String? locale}) {
  if (!milliseconds.isFinite) return '';
  final seconds = milliseconds < 0 ? 0 : (milliseconds / 1000).round();
  if (seconds == 0) return '\u2014';
  if (seconds < Duration.secondsPerDay) {
    final hours = seconds ~/ Duration.secondsPerHour;
    final minutes = (seconds % Duration.secondsPerHour) ~/ 60;
    if (hours > 0) {
      return '${hours}h ${minutes.toString().padLeft(2, '0')}m';
    }
    if (minutes > 0) return '${minutes}m';
    return '${seconds}s';
  }
  final resolved = _appLocale(locale);
  final l10n = lookupAppLocalizations(resolved);
  final joiner = switch (resolved.languageCode) {
    'zh' || 'ja' => '',
    _ => ' ',
  };
  String pair(String head, int tailCount, String Function(int) tail) =>
      tailCount == 0 ? head : '$head$joiner${tail(tailCount)}';
  var days = seconds ~/ Duration.secondsPerDay;
  if (days < 7) {
    var restHours =
        ((seconds - days * Duration.secondsPerDay) / Duration.secondsPerHour)
            .round();
    if (restHours == 24) {
      days += 1;
      restHours = 0;
    }
    return pair(
      l10n.usageCardDurationDays(days),
      restHours,
      l10n.usageCardDurationHours,
    );
  }
  if (days < 30) {
    return pair(
      l10n.usageCardDurationWeeks(days ~/ 7),
      days % 7,
      l10n.usageCardDurationDays,
    );
  }
  return pair(
    l10n.usageCardDurationMonths(days ~/ 30),
    days % 30,
    l10n.usageCardDurationDays,
  );
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
