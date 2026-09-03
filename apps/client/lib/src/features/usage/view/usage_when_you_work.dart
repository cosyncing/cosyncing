import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_format.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_figures.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

/// Hour-of-day and weekday rhythm, from the served insights facets.
///
/// Every number here is served: the peak hour, the peak weekday, and — the one
/// that matters most — the **night window itself**. Hardcoding 22:00–02:00
/// would make the night-owl index a claim about the reader rather than a
/// reading of their data.
///
/// When the facets are absent (a tokdash older than 2.5.0) the section
/// collapses to a notice naming what is missing. It does not draw an empty
/// chart, and it does not disappear silently.
class UsageWhenYouWork extends StatelessWidget {
  /// Creates the section.
  const UsageWhenYouWork({
    required this.hourly,
    required this.weekday,
    required this.timezone,
    required this.locale,
    super.key,
  });

  /// Served hourly facet, or `null` if tokdash did not serve it.
  final UsageReportHourly? hourly;

  /// Served weekday facet, or `null` if tokdash did not serve it.
  final UsageReportWeekday? weekday;

  /// The zone the buckets were cut in. Without it the buckets mean nothing.
  final String? timezone;

  /// BCP-47 tag for digit and weekday formatting.
  final String locale;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final hours = hourly?.buckets ?? const <UsageReportHourBucket>[];
    final days = weekday?.buckets ?? const <UsageReportWeekdayBucket>[];

    if (hours.isEmpty && days.isEmpty) {
      return Column(
        key: const Key('usage-report-when'),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          UsageSectionTitle(title: l10n.usageWhenTitle),
          InlineNotice(
            icon: Icons.schedule_outlined,
            text: l10n.usageWhenBlocked,
          ),
        ],
      );
    }

    return Column(
      key: const Key('usage-report-when'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        UsageSectionTitle(
          title: l10n.usageWhenTitle,
          // The zone rides on the heading, because it qualifies every bucket
          // beneath it rather than any single figure.
          suffix: timezone == null ? null : l10n.usageWhenTz(timezone!),
        ),
        if (hours.isNotEmpty) ...[
          _HourStrip(buckets: hours, locale: locale),
          const SizedBox(height: 12),
        ],
        LayoutBuilder(
          builder: (context, constraints) {
            final stacked = constraints.maxWidth < 520;
            final left = _Highlights(
              hourly: hourly,
              weekday: weekday,
              days: days,
              locale: locale,
            );
            final right = days.isEmpty
                ? const SizedBox.shrink()
                : _WeekdayRows(buckets: days, locale: locale);
            if (stacked) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [left, const SizedBox(height: 12), right],
              );
            }
            return Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: left),
                const SizedBox(width: 16),
                Expanded(child: right),
              ],
            );
          },
        ),
      ],
    );
  }
}

/// A 24-bar strip of fractional-height containers. No chart package.
class _HourStrip extends StatelessWidget {
  const _HourStrip({required this.buckets, required this.locale});

  final List<UsageReportHourBucket> buckets;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final byHour = <int, double>{
      for (final bucket in buckets) bucket.hour: bucket.tokens,
    };
    final peak = byHour.values.fold<double>(0, (a, b) => a > b ? a : b);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          height: 56,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              for (var hour = 0; hour < 24; hour++)
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 1),
                    child: _HourBar(
                      // A share of the busiest hour, so the tallest bar is the
                      // peak and every other bar is read against it.
                      fraction: peak <= 0 ? 0 : (byHour[hour] ?? 0) / peak,
                      tokens: tokens,
                    ),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 4),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            for (final hour in const [0, 6, 12, 18])
              Text(
                _hourLabel(hour, locale),
                style: theme.textTheme.labelSmall?.copyWith(
                  color: tokens.textTertiary,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
          ],
        ),
      ],
    );
  }
}

class _HourBar extends StatelessWidget {
  const _HourBar({required this.fraction, required this.tokens});

  final double fraction;
  final AppTokens tokens;

  @override
  Widget build(BuildContext context) {
    final safe = fraction.isFinite ? fraction.clamp(0.0, 1.0) : 0.0;
    return Align(
      alignment: Alignment.bottomCenter,
      child: FractionallySizedBox(
        // A zero-token hour still shows a hairline, so 24 bars read as a day
        // rather than as a chart that lost its axis.
        heightFactor: safe == 0 ? 0.02 : safe.clamp(0.06, 1.0),
        child: Container(
          decoration: BoxDecoration(
            color: Color.alphaBlend(
              tokens.accent.withValues(alpha: 0.35 + 0.65 * safe),
              tokens.surface2,
            ),
            borderRadius: BorderRadius.circular(tokens.radiusXs),
          ),
        ),
      ),
    );
  }
}

class _Highlights extends StatelessWidget {
  const _Highlights({
    required this.hourly,
    required this.weekday,
    required this.days,
    required this.locale,
  });

  final UsageReportHourly? hourly;
  final UsageReportWeekday? weekday;
  final List<UsageReportWeekdayBucket> days;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final peakHour = hourly?.peakHour;
    final nightShare = hourly?.nightShare;
    final peakWeekday = weekday?.peakWeekday;
    final nightWindow = usageNightWindowLabel(
      hourly?.nightHours ?? const [],
      locale,
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (peakHour != null)
          UsageFigureRow(
            label: l10n.usageWhenPeakHour,
            value: l10n.usageHourRange(
              _hourLabel(peakHour, locale),
              _hourLabel((peakHour + 1) % 24, locale),
            ),
          ),
        if (nightShare != null)
          UsageFigureRow(
            label: l10n.usageWhenNightOwl,
            value: formatUsagePercent(nightShare * 100, locale: locale),
            // No served window means no note. Naming a window tokdash did not
            // serve would turn a reading into an assertion.
            detail: nightWindow.isEmpty
                ? null
                : l10n.usageWhenNightNote(nightWindow),
          ),
        if (peakWeekday != null)
          UsageFigureRow(
            label: l10n.usageWhenPeakDay,
            value: usageWeekdayName(peakWeekday, locale, days),
          ),
      ],
    );
  }
}

class _WeekdayRows extends StatelessWidget {
  const _WeekdayRows({required this.buckets, required this.locale});

  final List<UsageReportWeekdayBucket> buckets;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final peak = buckets.fold<double>(
      0,
      (value, bucket) => bucket.tokens > value ? bucket.tokens : value,
    );
    final ordered = [...buckets]
      ..sort((a, b) => a.weekday.compareTo(b.weekday));

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final bucket in ordered)
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(
              children: [
                SizedBox(
                  width: 36,
                  child: Text(
                    usageWeekdayName(bucket.weekday, locale, buckets),
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: tokens.textSecondary,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: UsageShareBar(
                    fraction: peak <= 0 ? 0 : bucket.tokens / peak,
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  formatCompactCount(bucket.tokens, locale: locale),
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: tokens.textTertiary,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ],
            ),
          ),
      ],
    );
  }
}

String _hourLabel(int hour, String locale) {
  // A wall-clock label, formatted by the locale rather than assembled here.
  final normalized = hour % 24;
  return DateFormat.Hm(locale).format(DateTime(2000, 1, 1, normalized));
}

/// A localized weekday name for a served bucket index.
///
/// The facet indexes Monday as 0 and also serves an English `name`. The name is
/// used only as a fallback, so a Chinese reader is not handed "Sunday" by a
/// server that has no idea what locale is reading it.
String usageWeekdayName(
  int index,
  String locale,
  List<UsageReportWeekdayBucket> buckets,
) {
  if (index < 0 || index > 6) {
    return _servedName(index, buckets) ?? '';
  }
  // 2024-01-01 — the first instant of 2024 — was a Monday, which is what the
  // facet calls index 0.
  final day = DateTime.utc(2024).add(Duration(days: index));
  return DateFormat.E(locale).format(day);
}

String? _servedName(int index, List<UsageReportWeekdayBucket> buckets) {
  for (final bucket in buckets) {
    if (bucket.weekday == index) return bucket.name;
  }
  return null;
}

/// The served night window, printed as the hours it actually covers.
///
/// Returns an empty string when tokdash served no window, which suppresses the
/// note rather than substituting a plausible one.
String usageNightWindowLabel(List<int> nightHours, String locale) {
  if (nightHours.isEmpty) return '';
  final hours = [...nightHours]..sort();
  // The window wraps midnight, so its edges are the two hours with no
  // neighbour inside the set rather than simply the smallest and largest.
  var start = hours.first;
  for (final hour in hours) {
    if (!hours.contains((hour - 1) % 24)) {
      start = hour;
      break;
    }
  }
  var end = hours.last;
  for (final hour in hours) {
    if (!hours.contains((hour + 1) % 24)) {
      end = hour;
      break;
    }
  }
  return '${_hourLabel(start, locale)} – ${_hourLabel((end + 1) % 24, locale)}';
}
