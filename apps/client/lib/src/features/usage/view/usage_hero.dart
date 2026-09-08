import 'dart:ui' as ui show TextDirection;

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_format.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_period.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart' hide TextDirection;

/// The period's figures as a wrapping grid of stat tiles.
///
/// Mirrors the tokdash stats tiles: an uppercase quiet label over an extrabold
/// figure, with an optional meta line beneath. The tile set is fixed except for
/// the last one, which answers a different "peak" per period — day for a week,
/// week for a month, month for a year or all time. The grid reflows from four
/// columns to two at the compact breakpoint rather than clipping.
class UsageHero extends StatelessWidget {
  /// Creates the hero.
  const UsageHero({
    required this.period,
    required this.report,
    required this.locale,
    this.activeTimeTooltip,
    super.key,
  });

  /// Period being reported.
  final UsagePeriod period;

  /// The served report.
  final UsageReport report;

  /// How the agent-time estimate is made. Computed by the page from the served
  /// idle-gap cap, so this widget does not carry a second copy of that rule.
  final String? activeTimeTooltip;

  /// BCP-47 tag for figure formatting.
  final String locale;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final totals = report.totals;
    final activeMs = report.activeTime?.activeMsSum;
    final streaks = report.streaks;

    final tiles = <_StatTile>[
      _StatTile(
        label: l10n.usageStatTokens,
        value: formatCompactCount(totals.tokens, locale: locale),
      ),
      _StatTile(
        label: l10n.usageStatCost,
        value: formatUsageCost(totals.cost, locale: locale, compact: true),
        valueColor: context.tokens.costInk,
        // Cost is never a bare figure: the qualifier rides on the tile itself.
        tooltip: l10n.usageCostFooterNote,
      ),
      _StatTile(
        label: l10n.usageStatMessages,
        value: formatCompactCount(totals.requests, locale: locale),
      ),
      _StatTile(
        label: l10n.usageStatSessions,
        value: usageSessionCount(report) == null
            ? _emDash
            : formatUsageCount(usageSessionCount(report)!, locale: locale),
      ),
      if (activeMs != null)
        _StatTile(
          label: l10n.usageStatAgentTime,
          value: formatUsageAgentTime(activeMs, locale: locale),
          tooltip: activeTimeTooltip,
        ),
      if (totals.cacheHitRate != null)
        _StatTile(
          label: l10n.usageStatCacheHit,
          value: formatUsageShare(totals.cacheHitRate!, locale: locale),
        ),
      if (streaks?.currentStreak != null)
        _StatTile(
          label: l10n.usageStatStreak,
          value: formatCompactCount(streaks!.currentStreak!, locale: locale),
          meta: streaks.longestStreak == null
              ? null
              : l10n.usageStatStreakMeta(
                  formatCompactCount(streaks.longestStreak!, locale: locale),
                ),
        ),
      if (_peakTile(l10n) case final tile?) tile,
    ];

    return LayoutBuilder(
      builder: (context, constraints) {
        const spacing = 8.0;
        final columns = constraints.maxWidth >= 600 ? 4 : 2;
        final width =
            (constraints.maxWidth - spacing * (columns - 1)) / columns;
        return Wrap(
          key: const Key('usage-report-hero'),
          spacing: spacing,
          runSpacing: spacing,
          children: [
            for (final tile in tiles) SizedBox(width: width, child: tile),
          ],
        );
      },
    );
  }

  /// The period-dependent peak tile, or `null` when nothing served a peak.
  _StatTile? _peakTile(AppLocalizations l10n) {
    final peak = switch (period) {
      UsagePeriod.today ||
      UsagePeriod.week => usagePeakDay(report, locale: locale),
      UsagePeriod.month => usagePeakWeek(report, locale: locale),
      UsagePeriod.year ||
      UsagePeriod.allTime => usagePeakMonth(report, locale: locale),
    };
    if (peak == null) return null;
    return _StatTile(
      label: switch (period) {
        UsagePeriod.today || UsagePeriod.week => l10n.usageStatPeakDay,
        UsagePeriod.month => l10n.usageStatPeakWeek,
        UsagePeriod.year || UsagePeriod.allTime => l10n.usageStatPeakMonth,
      },
      value: formatCompactCount(peak.tokens, locale: locale),
      meta: peak.label,
    );
  }
}

const String _emDash = '—';

/// One tile in the hero grid: quiet label, loud figure, optional meta line.
class _StatTile extends StatelessWidget {
  const _StatTile({
    required this.label,
    required this.value,
    this.meta,
    this.valueColor,
    this.tooltip,
  });

  final String label;
  final String value;
  final String? meta;
  final Color? valueColor;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final valueStyle = theme.textTheme.headlineSmall?.copyWith(
      color: valueColor,
      fontWeight: FontWeight.w600,
      fontFeatures: const [FontFeature.tabularFigures()],
    );
    // The value slot is pinned to one unscaled line: a value long enough to
    // scale down must not shrink its tile against the row.
    final valueHeight = (TextPainter(
      text: TextSpan(text: '0', style: valueStyle),
      textDirection: ui.TextDirection.ltr,
      textScaler: MediaQuery.textScalerOf(context),
    )..layout()).height;
    final tile = Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      decoration: BoxDecoration(
        color: tokens.surface,
        border: Border.all(color: tokens.separator),
        borderRadius: BorderRadius.circular(tokens.radiusLg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label.toUpperCase(),
            overflow: TextOverflow.ellipsis,
            maxLines: 1,
            style: theme.textTheme.labelSmall?.copyWith(
              color: tokens.textTertiary,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.8,
            ),
          ),
          const SizedBox(height: 4),
          SizedBox(
            height: valueHeight,
            child: FittedBox(
              fit: BoxFit.scaleDown,
              alignment: Alignment.centerLeft,
              child: Text(value, style: valueStyle),
            ),
          ),
          // The subline slot is reserved even when empty: streak and peak
          // tiles carry meta and the rest do not, and an unconditional slot is
          // what keeps every tile in the grid the same height.
          const SizedBox(height: 2),
          Text(
            meta ?? '',
            overflow: TextOverflow.ellipsis,
            maxLines: 1,
            style: theme.textTheme.bodySmall?.copyWith(
              color: tokens.textTertiary,
            ),
          ),
        ],
      ),
    );
    return tooltip == null ? tile : Tooltip(message: tooltip, child: tile);
  }
}

/// A peak window: its tokens and the name of the window it peaked in.
typedef UsagePeak = ({double tokens, String label});

/// The served busiest day, labelled by its date.
UsagePeak? usagePeakDay(UsageReport report, {String? locale}) {
  final day = report.firsts?.busiestDay;
  final tokens = report.firsts?.busiestDayTokens;
  final date = day == null ? null : DateTime.tryParse(day);
  if (date == null || tokens == null) return null;
  return (
    tokens: tokens,
    label: DateFormat.MMMd(locale).format(date),
  );
}

/// The busiest Monday-first week in the window, folded from `daily[]`.
///
/// The DTO does not serve a weekly peak, and does not need to: `daily` already
/// carries one row per day, so the client sums the seven-day runs itself.
UsagePeak? usagePeakWeek(UsageReport report, {String? locale}) {
  return _peakBucket(
    report,
    bucketStart: (day) => day.subtract(Duration(days: day.weekday - 1)),
    label: (start) => DateFormat.MMMd(locale).format(start),
  );
}

/// The busiest calendar month in the window, folded from `daily[]`.
UsagePeak? usagePeakMonth(UsageReport report, {String? locale}) {
  return _peakBucket(
    report,
    bucketStart: (day) => DateTime.utc(day.year, day.month),
    label: (start) => DateFormat.MMMM(locale).format(start),
  );
}

UsagePeak? _peakBucket(
  UsageReport report, {
  required DateTime Function(DateTime day) bucketStart,
  required String Function(DateTime start) label,
}) {
  final daily = report.daily;
  if (daily == null || daily.isEmpty) return null;
  final sums = <DateTime, double>{};
  for (final row in daily) {
    final day = DateTime.tryParse(row.date);
    if (day == null || row.tokens <= 0) continue;
    final start = bucketStart(DateTime.utc(day.year, day.month, day.day));
    sums[start] = (sums[start] ?? 0) + row.tokens;
  }
  if (sums.isEmpty) return null;
  final best = sums.entries.reduce((a, b) => a.value >= b.value ? a : b);
  return (tokens: best.value, label: label(best.key));
}

/// Sessions in the period, from the active-time API or the per-tool rows.
///
/// Returns `null` rather than zero when neither source served a count.
int? usageSessionCount(UsageReport report) {
  final served = report.activeTime?.sessions;
  if (served != null) return served;
  var total = 0;
  var known = false;
  for (final tool in report.tools) {
    final sessions = tool.sessions;
    if (sessions != null) {
      total += sessions;
      known = true;
    }
  }
  return known ? total : null;
}
