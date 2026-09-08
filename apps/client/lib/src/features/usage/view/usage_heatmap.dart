import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:flutter/material.dart';

/// The smallest cell the grid will draw without falling back to scrolling.
const double usageHeatmapMinCell = 3;

/// The line box a 9px weekday label occupies. The gutter rows are sized to at
/// least this, because a label overflowing its box is clipped top and bottom —
/// and 9px is already the floor, so the box grows rather than the font
/// shrinking.
const double _weekdayLabelLineHeight = 12;

/// A Monday-first calendar grid of activity, one column per week.
///
/// Shaded by the **served** quartile `intensity` (1–4 over active days) from
/// the insights `daily` facet, not by a locally computed share of the maximum.
/// That is the same rank tokdash's own dashboard shades by, so one bucketing
/// rule covers both surfaces and neither this widget nor the broker invents a
/// threshold. A day with no served row is inactive, which is a different cell
/// from a day outside the window.
///
/// Days outside `[from, to]` are holes (transparent), not inactive cells: an
/// empty cell would claim the user did nothing on a date the report never
/// covered. One caller deliberately plays against that rule: the month period
/// extends `to` to the calendar month end, so the days after today sit INSIDE
/// the grid window and draw as inactive cells, GitHub-style — a full month
/// grid rather than a grid that stops at today. That is a caller decision
/// about a known-future tail, not this widget restating coverage.
///
/// No package and no `GridView`: a fixed `Row` of week columns, each a
/// `Column` of seven cells. The cell edge is solved against the available
/// width — `(maxWidth - gutter) / weekCount - gap`, clamped to
/// `[minCellSize, maxCellSize]` — so a year fills a wide pane instead of
/// drawing as a 300px strip in it, and the horizontal scroll view remains
/// only as the fallback below the legible minimum.
class UsageHeatmap extends StatelessWidget {
  /// Creates a heatmap over `[from, to]`.
  const UsageHeatmap({
    required this.from,
    required this.to,
    required this.intensityByDate,
    this.maxCellSize = 12,
    this.minCellSize = usageHeatmapMinCell,
    this.gap = 3,
    this.showWeekdayLabels = true,
    this.weekdayLabels = const <int, String>{},
    this.centerWhenCapped = false,
    super.key,
  });

  /// First day of the window, inclusive.
  final DateTime from;

  /// Last day of the window, inclusive.
  final DateTime to;

  /// `YYYY-MM-DD` to served quartile rank; absent means the day had no
  /// activity, and `0` means the same.
  final Map<String, int> intensityByDate;

  /// Largest edge a cell grows to when the width allows more. Short windows
  /// keep their previous density instead of ballooning into tiles.
  final double maxCellSize;

  /// Smallest legible edge. Below this the grid stops shrinking and scrolls.
  final double minCellSize;

  /// Space between cells.
  final double gap;

  /// Whether to print the weekday gutter.
  final bool showWeekdayLabels;

  /// Weekday index (1 = Monday) to its short label. Rows with no entry stay
  /// blank, which is how the compact breakpoint prints Mon/Wed/Fri only.
  final Map<int, String> weekdayLabels;

  /// Whether a width-capped grid centers instead of hugging the leading edge.
  ///
  /// A short window in a wide pane solves to a cell edge far above
  /// [maxCellSize]; clamped back down, its columns strand against one side.
  /// Centering makes the strip read as deliberate. Long windows never cap, so
  /// they are untouched.
  final bool centerWhenCapped;

  /// The alpha steps for ranks 1–4, over [AppTokens.surface2].
  ///
  /// The fill only ever approaches full accent, and accent is already contrast
  /// verified against its ink in both brightnesses, so every theme reskins this
  /// for free.
  static const List<double> intensityAlpha = [0.40, 0.60, 0.80, 1.0];

  /// Room reserved for the weekday gutter when it is shown.
  static double gutterWidth(double gap) => 28 + gap * 2;

  /// The week columns `[from, to]` spans once aligned to Monday.
  static int weekCount(DateTime from, DateTime to) {
    final start = DateTime.utc(from.year, from.month, from.day);
    final end = DateTime.utc(to.year, to.month, to.day);
    if (end.isBefore(start)) return 0;
    final lead = start.weekday - 1;
    final days = end.difference(start).inDays + 1;
    return ((lead + days) / 7).ceil();
  }

  /// The cell edge the width alone would give, before clamping.
  double _derivedCellSize(double maxWidth) {
    final weeks = weekCount(from, to);
    if (weeks <= 0 || !maxWidth.isFinite) return maxCellSize;
    final gutter = showWeekdayLabels && weekdayLabels.isNotEmpty
        ? gutterWidth(gap)
        : 0.0;
    return (maxWidth - gutter) / weeks - gap;
  }

  /// The cell edge that fills [maxWidth], clamped to the legible range.
  double cellSizeFor(double maxWidth) =>
      _derivedCellSize(maxWidth).clamp(minCellSize, maxCellSize);

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
        column.add(day.isBefore(start) || day.isAfter(end) ? null : day);
      }
      weeks.add(column);
      cursor = cursor.add(const Duration(days: 7));
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        final raw = _derivedCellSize(constraints.maxWidth);
        final cellSize = raw.clamp(minCellSize, maxCellSize);
        // The gutter row carries the label's line box, never less: a 9px label
        // in a 7px box is clipped top and bottom, which is the defect this
        // height exists to prevent. Grid rows carry the same height so cells
        // and labels stay aligned.
        final rowHeight =
            cellSize < _weekdayLabelLineHeight &&
                showWeekdayLabels &&
                weekdayLabels.isNotEmpty
            ? _weekdayLabelLineHeight
            : cellSize;

        final gutter = showWeekdayLabels && weekdayLabels.isNotEmpty
            ? _WeekdayGutter(
                labels: weekdayLabels,
                rowHeight: rowHeight,
                gap: gap,
              )
            : null;

        final grid = Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          // Shrink-wrap when the caller centers a capped grid: a max-width row
          // fills the pane and its columns hug the start no matter what wraps
          // it.
          mainAxisSize: centerWhenCapped ? MainAxisSize.min : MainAxisSize.max,
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
                        child: SizedBox(
                          height: rowHeight,
                          child: Center(
                            child: _Cell(
                              size: cellSize,
                              radius: tokens.radiusXs,
                              color: day == null
                                  ? Colors.transparent
                                  : _fill(
                                      tokens,
                                      intensityByDate[_key(day)] ?? 0,
                                    ),
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
          ],
        );

        // The scroll view is the fallback below the legible minimum: a window
        // whose solved cell edge came out under it wanted more room than the
        // pane has.
        if (raw < minCellSize && constraints.maxWidth.isFinite) {
          return SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: grid,
          );
        }
        if (centerWhenCapped && raw > maxCellSize) {
          return Center(child: grid);
        }
        return grid;
      },
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

  /// The fill for one served quartile rank, public so the export card's
  /// canvas cells shade by the same rule as this widget's.
  static Color intensityFill(AppTokens tokens, int intensity) =>
      _fill(tokens, intensity);
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
    required this.rowHeight,
    required this.gap,
  });

  final Map<int, String> labels;
  final double rowHeight;
  final double gap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        for (var weekday = 1; weekday <= 7; weekday++)
          Container(
            height: rowHeight,
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

/// One bar per day over `[from, to]`, height ranked against the window's
/// busiest day.
///
/// The report's month and year views carry this under the heatmap: the grid
/// says WHICH days were active, the bars say how much. The week view does not
/// get one — seven cells already read as magnitudes, and the `When you work`
/// buckets own the within-week shape. Built from the served `daily` rows'
/// token counts; a day with no row is a zero-height bar, not a gap in the
/// strip.
class UsageDailyHistogram extends StatelessWidget {
  /// Creates a daily histogram over `[from, to]`.
  const UsageDailyHistogram({
    required this.from,
    required this.to,
    required this.tokensByDate,
    this.height = 48,
    super.key,
  });

  /// First day of the window, inclusive.
  final DateTime from;

  /// Last day of the window, inclusive.
  final DateTime to;

  /// `YYYY-MM-DD` to served token count; absent means the day had no row.
  final Map<String, double> tokensByDate;

  /// Height of the strip, bars included.
  final double height;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final start = DateTime.utc(from.year, from.month, from.day);
    final end = DateTime.utc(to.year, to.month, to.day);
    if (end.isBefore(start)) return const SizedBox.shrink();
    final days = end.difference(start).inDays + 1;

    var peak = 0.0;
    final counts = <double>[];
    for (var i = 0; i < days; i++) {
      final count =
          tokensByDate[UsageHeatmap._key(start.add(Duration(days: i)))] ?? 0;
      counts.add(count);
      if (count > peak) peak = count;
    }

    return LayoutBuilder(
      builder: (context, constraints) {
        const spacing = 1.0;
        final barWidth = (constraints.maxWidth - spacing * (days - 1)) / days;
        return SizedBox(
          height: height,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              for (var i = 0; i < days; i++) ...[
                if (i > 0) const SizedBox(width: spacing),
                Container(
                  width: barWidth,
                  // An active day never rounds to nothing: it gets a visible
                  // floor so the bar answers "was there work" even when the
                  // peak dwarfs it.
                  height: counts[i] <= 0
                      ? 0
                      : (counts[i] / peak * (height - 2)).clamp(2.0, height),
                  decoration: BoxDecoration(
                    color: counts[i] <= 0
                        ? Colors.transparent
                        : tokens.accent.withValues(alpha: 0.85),
                    borderRadius: BorderRadius.circular(tokens.radiusXs),
                  ),
                ),
              ],
            ],
          ),
        );
      },
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
