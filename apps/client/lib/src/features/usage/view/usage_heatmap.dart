import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:flutter/material.dart';

/// A Monday-first calendar grid of activity, one column per week.
///
/// Shaded by the **served** quartile `intensity` (1–4 over active days) from
/// the insights `daily` facet, not by a locally computed share of the maximum.
/// That is the same rank tokdash's own dashboard shades by, so one bucketing
/// rule covers both surfaces and neither this widget nor the broker invents a
/// threshold. A day with no served row is inactive, which is a different cell
/// from a day outside the window.
///
/// No package and no `GridView`: a fixed `Row` of week columns, each a `Column`
/// of seven cells. The month and year densities are the same widget at two cell
/// sizes.
class UsageHeatmap extends StatelessWidget {
  /// Creates a heatmap over `[from, to]`.
  const UsageHeatmap({
    required this.from,
    required this.to,
    required this.intensityByDate,
    this.cellSize = 12,
    this.gap = 3,
    this.showWeekdayLabels = true,
    this.weekdayLabels = const <int, String>{},
    super.key,
  });

  /// First day of the window, inclusive.
  final DateTime from;

  /// Last day of the window, inclusive.
  final DateTime to;

  /// `YYYY-MM-DD` to served quartile rank; absent means the day had no
  /// activity, and `0` means the same.
  final Map<String, int> intensityByDate;

  /// Edge length of one day cell.
  final double cellSize;

  /// Space between cells.
  final double gap;

  /// Whether to print the weekday gutter.
  final bool showWeekdayLabels;

  /// Weekday index (1 = Monday) to its short label. Rows with no entry stay
  /// blank, which is how the compact breakpoint prints Mon/Wed/Fri only.
  final Map<int, String> weekdayLabels;

  /// The alpha steps for ranks 1–4, over [AppTokens.surface2].
  ///
  /// The fill only ever approaches full accent, and accent is already contrast
  /// verified against its ink in both brightnesses, so every theme reskins this
  /// for free.
  static const List<double> intensityAlpha = [0.40, 0.60, 0.80, 1.0];

  static String _key(DateTime day) =>
      '${day.year.toString().padLeft(4, '0')}-'
      '${day.month.toString().padLeft(2, '0')}-'
      '${day.day.toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final start = DateTime.utc(from.year, from.month, from.day);
    final end = DateTime.utc(to.year, to.month, to.day);
    if (end.isBefore(start)) return const SizedBox.shrink();

    // Back up to the Monday on or before the first day, so every column is a
    // real week and the weekday gutter lines up with the rows.
    final gridStart = start.subtract(Duration(days: start.weekday - 1));
    final weeks = <List<DateTime?>>[];
    var cursor = gridStart;
    while (!cursor.isAfter(end)) {
      final column = <DateTime?>[];
      for (var i = 0; i < 7; i++) {
        final day = cursor.add(Duration(days: i));
        // Days outside the window are holes, not inactive days: an empty cell
        // would claim the user did nothing on a date the report never covered.
        column.add(day.isBefore(start) || day.isAfter(end) ? null : day);
      }
      weeks.add(column);
      cursor = cursor.add(const Duration(days: 7));
    }

    final gutter = showWeekdayLabels && weekdayLabels.isNotEmpty
        ? _WeekdayGutter(
            labels: weekdayLabels,
            cellSize: cellSize,
            gap: gap,
          )
        : null;

    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (gutter != null) ...[gutter, SizedBox(width: gap * 2)],
          for (final week in weeks)
            Padding(
              padding: EdgeInsets.only(right: gap),
              child: Column(
                children: [
                  for (final day in week)
                    Padding(
                      padding: EdgeInsets.only(bottom: gap),
                      child: _Cell(
                        size: cellSize,
                        radius: tokens.radiusXs,
                        color: day == null
                            ? Colors.transparent
                            : _fill(tokens, intensityByDate[_key(day)] ?? 0),
                      ),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  static Color _fill(AppTokens tokens, int intensity) {
    if (intensity <= 0) return tokens.surface2;
    final step = intensity.clamp(1, intensityAlpha.length);
    return Color.alphaBlend(
      tokens.accent.withValues(alpha: intensityAlpha[step - 1]),
      tokens.surface2,
    );
  }
}

class _Cell extends StatelessWidget {
  const _Cell({required this.size, required this.radius, required this.color});

  final double size;
  final double radius;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(radius),
      ),
    );
  }
}

class _WeekdayGutter extends StatelessWidget {
  const _WeekdayGutter({
    required this.labels,
    required this.cellSize,
    required this.gap,
  });

  final Map<int, String> labels;
  final double cellSize;
  final double gap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        for (var weekday = 1; weekday <= 7; weekday++)
          Container(
            height: cellSize,
            margin: EdgeInsets.only(bottom: gap),
            alignment: Alignment.centerRight,
            child: Text(
              labels[weekday] ?? '',
              style: theme.textTheme.labelSmall?.copyWith(
                color: context.tokens.textTertiary,
                fontSize: 9,
              ),
            ),
          ),
      ],
    );
  }
}

/// The `Less ▢▢▢▢ More` scale under a heatmap.
class UsageHeatmapLegend extends StatelessWidget {
  /// Creates the legend.
  const UsageHeatmapLegend({
    required this.lessLabel,
    required this.moreLabel,
    this.cellSize = 10,
    super.key,
  });

  /// Label at the inactive end.
  final String lessLabel;

  /// Label at the busiest end.
  final String moreLabel;

  /// Edge length of a swatch.
  final double cellSize;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final style = theme.textTheme.bodySmall?.copyWith(
      color: tokens.textTertiary,
    );
    return Row(
      mainAxisAlignment: MainAxisAlignment.end,
      children: [
        Text(lessLabel, style: style),
        const SizedBox(width: 6),
        for (var rank = 0; rank <= UsageHeatmap.intensityAlpha.length; rank++)
          Padding(
            padding: const EdgeInsets.only(right: 3),
            child: _Cell(
              size: cellSize,
              radius: tokens.radiusXs,
              color: UsageHeatmap._fill(tokens, rank),
            ),
          ),
        const SizedBox(width: 3),
        Text(moreLabel, style: style),
      ],
    );
  }
}
