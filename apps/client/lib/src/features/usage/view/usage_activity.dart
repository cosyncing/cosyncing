import 'dart:math' as math;

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/window_size_class.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_format.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_period.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_detail_dialog.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_figures.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_heatmap.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_when_you_work.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

enum _ActivityMetric { tokens, cost, messages }

/// Period-aware activity drawn only from the report's served buckets.
class UsageActivity extends StatefulWidget {
  /// Creates activity charts for a report window.
  const UsageActivity({
    required this.period,
    required this.report,
    required this.locale,
    required this.now,
    super.key,
  });

  /// Clock used to distinguish current and complete windows.
  final DateTime now;

  /// Selected range.
  final UsagePeriod period;

  /// Real report from the selected broker.
  final UsageReport report;

  /// Number and calendar formatting locale.
  final String locale;

  @override
  State<UsageActivity> createState() => _UsageActivityState();
}

class _UsageActivityState extends State<UsageActivity> {
  _ActivityMetric _metric = _ActivityMetric.tokens;

  double _amount(double tokens, double cost, int messages) => switch (_metric) {
    _ActivityMetric.tokens => tokens,
    _ActivityMetric.cost => cost,
    _ActivityMetric.messages => messages.toDouble(),
  };

  String _format(double amount) => _metric == _ActivityMetric.cost
      ? formatUsageCost(amount, locale: widget.locale)
      : formatUsageCount(amount, locale: widget.locale);

  String _barDescription(_ActivityBar bar, AppLocalizations l10n) {
    final amount = bar.value == null
        ? l10n.usageEnhancementNoReading
        : _format(bar.value!);
    return '${bar.label} · $amount';
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final report = widget.report;
    final daily = report.daily ?? const <UsageReportDay>[];
    final requestedFrom = DateTime.tryParse(report.range.from);
    final servedTo = DateTime.tryParse(report.range.to);
    if (requestedFrom == null || servedTo == null) {
      return const SizedBox.shrink();
    }
    final today = DateTime(widget.now.year, widget.now.month, widget.now.day);
    final to = servedTo.isAfter(today) ? today : servedTo;
    final from = widget.period == UsagePeriod.allTime && daily.isNotEmpty
        ? daily
                  .map((day) => DateTime.tryParse(day.date))
                  .nonNulls
                  .fold<DateTime?>(
                    null,
                    (earliest, date) =>
                        earliest == null || date.isBefore(earliest)
                        ? date
                        : earliest,
                  ) ??
              requestedFrom
        : requestedFrom;
    final dayView = widget.period == UsagePeriod.today;
    final showCalendar = !dayView && widget.period != UsagePeriod.week;
    final calendarTo = widget.period == UsagePeriod.month
        ? DateTime(servedTo.year, servedTo.month + 1, 0)
        : to;
    final byDay = {for (final day in daily) day.date: day};
    final byHour = {
      for (final hour in report.hourly?.buckets ?? <UsageReportHourBucket>[])
        hour.hour: hour,
    };
    final dayCount =
        DateTime.utc(
          to.year,
          to.month,
          to.day,
        ).difference(DateTime.utc(from.year, from.month, from.day)).inDays +
        1;
    // The normalized contract preserves sparse lists but has no per-bucket
    // coverage guarantee. A missing row is a visible gap, never an exact zero.
    final bars = <_ActivityBar>[];
    if (dayView && byHour.isNotEmpty) {
      for (var hour = 0; hour < 24; hour++) {
        final bucket = byHour[hour];
        final label = DateFormat.Hm(
          widget.locale,
        ).format(DateTime(2000, 1, 1, hour));
        bars.add(
          _ActivityBar(
            label: label,
            value: bucket == null
                ? null
                : _amount(bucket.tokens, bucket.cost, bucket.requests),
            onTap: bucket == null
                ? null
                : () => showUsageDetailDialog(
                    context,
                    title: label,
                    locale: widget.locale,
                    tokens: bucket.tokens,
                    cost: bucket.cost,
                    messages: bucket.requests,
                  ),
          ),
        );
      }
    } else if (!dayView && daily.isNotEmpty && dayCount > 0) {
      for (var index = 0; index < dayCount; index++) {
        final date = DateTime.utc(from.year, from.month, from.day + index);
        final key = DateFormat('yyyy-MM-dd').format(date);
        final bucket = byDay[key];
        final label = DateFormat.yMMMd(widget.locale).format(date);
        bars.add(
          _ActivityBar(
            label: label,
            value: bucket == null
                ? null
                : _amount(bucket.tokens, bucket.cost, bucket.requests),
            onTap: bucket == null
                ? null
                : () => showUsageDetailDialog(
                    context,
                    title: label,
                    locale: widget.locale,
                    tokens: bucket.tokens,
                    cost: bucket.cost,
                    messages: bucket.requests,
                  ),
          ),
        );
      }
    }
    final peak = bars.fold<double>(
      0,
      (peak, bar) => math.max(peak, bar.value ?? 0),
    );
    // Token calendars retain upstream quartiles. Other metrics have their own
    // quartiles over nonzero covered days; switching never leaves token colors.
    final values =
        daily
            .map((day) => _amount(day.tokens, day.cost, day.requests))
            .where((value) => value > 0)
            .toList()
          ..sort();
    int intensity(UsageReportDay day) {
      if (_metric == _ActivityMetric.tokens) return day.intensity ?? 0;
      final value = _amount(day.tokens, day.cost, day.requests);
      if (value <= 0 || values.isEmpty) return 0;
      final rank = values.lastIndexWhere((entry) => entry <= value) + 1;
      return (rank / values.length * 4).ceil().clamp(1, 4);
    }

    return Column(
      key: const Key('usage-report-active-days'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        UsageSectionTitle(title: l10n.usageEnhancementActivity),
        Wrap(
          spacing: 4,
          children: [
            for (final metric in _ActivityMetric.values)
              ChoiceChip(
                key: Key('usage-activity-metric-${metric.name}'),
                label: Text(switch (metric) {
                  _ActivityMetric.tokens => l10n.usageTokensLabel,
                  _ActivityMetric.cost => l10n.usageColCost,
                  _ActivityMetric.messages => l10n.usageStatMessages,
                }),
                selected: _metric == metric,
                onSelected: (_) => setState(() => _metric = metric),
              ),
          ],
        ),
        const SizedBox(height: 12),
        if (showCalendar && daily.isNotEmpty) ...[
          UsageHeatmap(
            from: from,
            to: calendarTo,
            intensityByDate: {
              for (final day in daily)
                if (day.date.compareTo(DateFormat('yyyy-MM-dd').format(to)) <=
                    0)
                  day.date: intensity(day),
            },
            dateTooltip: (date) {
              final bucket = byDay[DateFormat('yyyy-MM-dd').format(date)];
              final value = date.isAfter(to) || bucket == null
                  ? l10n.usageEnhancementNoReading
                  : _format(
                      _amount(bucket.tokens, bucket.cost, bucket.requests),
                    );
              return '${DateFormat.yMMMd(widget.locale).format(date)} · $value';
            },
            isDateEnabled: (date) =>
                !date.isAfter(to) &&
                byDay.containsKey(DateFormat('yyyy-MM-dd').format(date)),
            onDateSelected: (date) {
              final bucket = byDay[DateFormat('yyyy-MM-dd').format(date)]!;
              showUsageDetailDialog(
                context,
                title: DateFormat.yMMMd(widget.locale).format(date),
                locale: widget.locale,
                tokens: bucket.tokens,
                cost: bucket.cost,
                messages: bucket.requests,
              );
            },
            minCellSize: 8,
            gap: 4,
            weekdayLabels: {
              for (final day in const [1, 3, 5])
                day: usageWeekdayName(day - 1, widget.locale, const []),
            },
          ),
          const SizedBox(height: 8),
          UsageHeatmapLegend(
            lessLabel: l10n.usageLegendLess,
            moreLabel: l10n.usageLegendMore,
          ),
          const SizedBox(height: 16),
        ],
        if (bars.isEmpty)
          InlineNotice(text: l10n.usageWhenBlocked)
        else ...[
          LayoutBuilder(
            builder: (context, constraints) {
              final compact =
                  WindowSizeClass.of(context) == WindowSizeClass.compact;
              final width = compact
                  ? math.max(constraints.maxWidth, bars.length * 12.0)
                  : constraints.maxWidth;
              final gap = math.min<double>(2, width / bars.length * 0.15);
              return SingleChildScrollView(
                key: Key(
                  dayView ? 'usage-hourly-activity' : 'usage-daily-activity',
                ),
                // Chronological bars remain left-to-right. On phones, show
                // recent days first and let the user scroll back in time.
                reverse: compact,
                scrollDirection: Axis.horizontal,
                child: SizedBox(
                  width: width,
                  child: Column(
                    children: [
                      SizedBox(
                        height: 88,
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            for (final bar in bars)
                              Expanded(
                                child: Tooltip(
                                  message: _barDescription(bar, l10n),
                                  child: Semantics(
                                    label: _barDescription(bar, l10n),
                                    button: bar.onTap != null,
                                    child: InkWell(
                                      onTap: bar.onTap,
                                      child: Padding(
                                        padding: EdgeInsets.symmetric(
                                          horizontal: gap,
                                        ),
                                        child: Align(
                                          alignment: Alignment.bottomCenter,
                                          child: Container(
                                            height:
                                                peak <= 0 ||
                                                    (bar.value ?? 0) <= 0
                                                ? 1
                                                : math.max(
                                                    4,
                                                    bar.value! / peak * 80,
                                                  ),
                                            decoration: BoxDecoration(
                                              color: (bar.value ?? 0) <= 0
                                                  ? context.tokens.separator
                                                  : context.tokens.accent
                                                        .withValues(
                                                          alpha: 0.8,
                                                        ),
                                              borderRadius:
                                                  BorderRadius.circular(
                                                    context.tokens.radiusXs,
                                                  ),
                                            ),
                                          ),
                                        ),
                                      ),
                                    ),
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
                          Flexible(
                            child: Text(
                              bars.first.label,
                              style: Theme.of(context).textTheme.labelSmall,
                            ),
                          ),
                          Flexible(
                            child: Text(
                              bars.last.label,
                              textAlign: TextAlign.end,
                              style: Theme.of(context).textTheme.labelSmall,
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
        ],
        // A day's streak line only restates the day: one of one days active,
        // and today as the busiest of them.
        if (_streakLine(
              l10n,
              report,
              widget.locale,
              windowIsOpen: !to.isBefore(
                DateTime(widget.now.year, widget.now.month, widget.now.day),
              ),
            )
            case final line? when !dayView) ...[
          const SizedBox(height: 12),
          UsageFootnote(text: line),
        ],
      ],
    );
  }

  static String? _streakLine(
    AppLocalizations l10n,
    UsageReport report,
    String locale, {
    required bool windowIsOpen,
  }) {
    final streaks = report.streaks;
    final activeDays = streaks?.activeDays;
    final totalDays = streaks?.totalDays;
    if (activeDays == null || totalDays == null) return null;

    final active = formatCompactCount(activeDays, locale: locale);
    final total = formatCompactCount(totalDays, locale: locale);
    final busiest = report.firsts?.busiestDay;
    final busiestTokens = report.firsts?.busiestDayTokens;
    final busiestDate = busiest == null ? null : DateTime.tryParse(busiest);
    if (busiestDate == null || busiestTokens == null) {
      return l10n.usageStreakLineShort(active, total);
    }

    final date = DateFormat.MMMd(locale).format(busiestDate);
    final tokens = formatCompactCount(busiestTokens, locale: locale);
    final current = streaks?.currentStreak;
    if (!windowIsOpen || current == null || current <= 0) {
      return l10n.usageDaysBusiestLine(active, total, date, tokens);
    }
    return l10n.usageStreakLine(
      formatCompactCount(current, locale: locale),
      active,
      total,
      date,
      tokens,
    );
  }
}

class _ActivityBar {
  const _ActivityBar({
    required this.label,
    required this.value,
    required this.onTap,
  });
  final String label;
  final double? value;
  final VoidCallback? onTap;
}
