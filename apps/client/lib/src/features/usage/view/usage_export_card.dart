import 'dart:math' as math;
import 'dart:ui' as ui show TextDirection;

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_format.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_period.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_agent_logo.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_heatmap.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

/// Which of the two cards this is.
///
/// The privacy boundary is *which button you pressed*, not a toggle state. One
/// card carries counts only; the other adds project names. There is no setting
/// that moves content across that line, so a sender never has to audit a
/// checkbox before posting the image. Each card says which it is in its
/// eyebrow, in its tier colour.
enum UsageExportCardKind {
  /// Counts only. No project names, no prompt text. Safe to post.
  overview,

  /// Counts plus project names. Share deliberately.
  projectDetail;

  /// Whether this card carries project names.
  bool get carriesProjectNames => this == UsageExportCardKind.projectDetail;
}

/// The logical width of an export card. 5× of this is the exported PNG width.
const double usageExportCardWidth = 360;

/// The logical height of an export card.
const double usageExportCardHeight = 640;

/// Left/right padding, top padding, bottom padding — tokdash's card geometry.
const double _padX = 24;
const double _padTop = 26;
const double _padBottom = 18;

/// The content cursor must stop here: the bottom padding plus a small margin.
const double _budget = usageExportCardHeight - _padBottom - 6;

/// Ascent share of the font size, close enough for the card's fonts. Baselines
/// are placed with it, exactly as tokdash's `AS`.
const double _ascentShare = 0.78;

const String _em = '—';

/// One harness mark's place on the card: top-left corner and tool id.
@immutable
class UsageExportCardIconSpot {
  /// Creates a spot.
  const UsageExportCardIconSpot({
    required this.x,
    required this.y,
    required this.tool,
  });

  /// Left edge, logical px.
  final double x;

  /// Top edge, logical px.
  final double y;

  /// Served tool id.
  final String tool;
}

/// One positioned drawing operation on the card canvas.
sealed class UsageExportCardOp {}

class _RectOp extends UsageExportCardOp {
  _RectOp(this.rect, this.fill, this.radius, this.stroke);

  final Rect rect;
  final Color fill;
  final double radius;
  final Color? stroke;
}

class _TextOp extends UsageExportCardOp {
  _TextOp({
    required this.x,
    required this.y,
    required this.painter,
    required this.alignRight,
  });

  /// Left edge, or the right edge when [alignRight].
  final double x;

  /// Top edge of the laid-out line box.
  final double y;

  final TextPainter painter;
  final bool alignRight;
}

/// A fully laid-out card: every glyph and rect positioned, in logical px.
///
/// Layout is computed up front — a tokdash-style ops model rather than a
/// widget tree — because the card must MEASURE itself to fit itself: the
/// fitter rebuilds the model down a ladder of densities and keeps the first
/// one that lands inside the frame. A `FittedBox` scale-down was the previous
/// answer, and it made every dense period a little blurrier at print
/// resolution; dropping a project row is honest, shrinking 34px digits is not.
///
/// Text painters are laid out with [TextScaler.noScaling]: the card is an
/// artifact, and an artifact does not inherit the capturing device's text
/// scale.
class UsageExportCardPlan {
  UsageExportCardPlan._({
    required this.background,
    required this.maxProjects,
    required this.cellCap,
    required this.used,
    required this.ops,
    required this.icons,
    required this.heatCells,
    required this.heatLeft,
    required this.heatRight,
  });

  /// Paints, measures, and adjusts, down tokdash's ladder: heat cells shrink
  /// before project rows drop, because a small cell is thin and a missing row
  /// is a lie. The first pass wants breathing room; the second takes anything
  /// that fits at all. Text never scales — except the hero, which steps 34→20
  /// to hold its own line.
  factory UsageExportCardPlan.fit({
    required UsageExportCardKind kind,
    required UsagePeriod period,
    required UsageReport report,
    required String locale,
    required bool includeCost,
    required AppLocalizations l10n,
    required AppTokens tokens,
    required TextStyle baseStyle,
  }) {
    final attempts = kind.carriesProjectNames
        ? const <(int, double)>[
            (3, 11),
            (3, 10),
            (3, 9),
            (2, 10),
            (1, 9),
            // Last resort: the label stays, the rows go. Still a worse card,
            // but never one that runs out of its own frame.
            (0, 7),
          ]
        : const <(int, double)>[(0, 11), (0, 9), (0, 7), (0, 5)];
    UsageExportCardPlan? last;
    for (final slack in const [12.0, 0.0]) {
      for (final (maxProjects, cellCap) in attempts) {
        last = _UsageCardBuilder(
          kind: kind,
          period: period,
          report: report,
          locale: locale,
          includeCost: includeCost,
          l10n: l10n,
          tokens: tokens,
          baseStyle: baseStyle,
          maxProjects: maxProjects,
          cellCap: cellCap,
        ).build();
        if (last.slack >= slack) return last;
      }
    }
    return last!;
  }

  /// The card's canvas colour.
  final Color background;

  /// Project rows the fitter allowed this plan.
  final int maxProjects;

  /// Heat cell cap the fitter allowed this plan.
  final double cellCap;

  /// Bottom of the last content, logical px.
  final double used;

  /// The positioned rect and text ops, in paint order.
  final List<UsageExportCardOp> ops;

  /// Harness mark positions, painted as widgets over the canvas.
  final List<UsageExportCardIconSpot> icons;

  /// Heat cells drawn; 0 when the period carries no heat block.
  final int heatCells;

  /// Leftmost heat cell edge, or `null` when there is no block.
  final double? heatLeft;

  /// Rightmost heat cell edge, or `null` when there is no block.
  final double? heatRight;

  /// The frame's content budget, logical px.
  double get budget => _budget;

  /// Every string the card draws, for tests and audits.
  List<String> get texts => [
    for (final op in ops)
      if (op is _TextOp) (op.painter.text! as TextSpan).text ?? '',
  ];

  /// Slack below the budget. Negative when even the sparsest rung overflowed;
  /// the card renders anyway, because a clipped card beats no card, and the
  /// number is here for the audit rather than silently swallowed.
  double get slack => budget - used;
}

class _UsageCardBuilder {
  _UsageCardBuilder({
    required this.kind,
    required this.period,
    required this.report,
    required this.locale,
    required this.includeCost,
    required this.l10n,
    required this.tokens,
    required this.baseStyle,
    required this.maxProjects,
    required this.cellCap,
  });

  final UsageExportCardKind kind;
  final UsagePeriod period;
  final UsageReport report;
  final String locale;
  final bool includeCost;
  final AppLocalizations l10n;
  final AppTokens tokens;
  final TextStyle baseStyle;
  final int maxProjects;
  final double cellCap;

  static const double _left = _padX;
  static const double _right = usageExportCardWidth - _padX;
  static const double _contentWidth = _right - _left;

  final List<UsageExportCardOp> _ops = [];
  final List<UsageExportCardIconSpot> _icons = [];
  double _top = _padTop;
  var _heatCells = 0;
  double? _heatLeft;
  double? _heatRight;

  /// The tier colour: the app accent on the overview, the amber
  /// needs-attention colour on the project card — the same pairing the old
  /// tier labels used, so both brightnesses and every registered theme reskin
  /// the card for free.
  Color get _tierAccent =>
      kind.carriesProjectNames ? tokens.statusNeedsInput : tokens.accent;

  TextStyle _style(double size, FontWeight weight, Color color) =>
      baseStyle.copyWith(
        fontSize: size,
        fontWeight: weight,
        color: color,
        // The model positions every baseline itself; a style height would
        // fight it.
        height: 1,
      );

  TextPainter _painter(String value, TextStyle style) => TextPainter(
    text: TextSpan(text: value, style: style),
    textDirection: ui.TextDirection.ltr,
    textScaler: TextScaler.noScaling,
    maxLines: 1,
  )..layout();

  double _measure(String value, TextStyle style) =>
      _painter(value, style).width;

  /// Emits a text op whose BASELINE is [baseline]. The op stores the line
  /// box's top, computed from the font's real ascent.
  void _emit(
    String value,
    double size,
    FontWeight weight,
    Color color,
    double baseline, {
    double? x,
    bool alignRight = false,
  }) {
    final painter = _painter(value, _style(size, weight, color));
    final ascent = painter.computeLineMetrics().first.ascent;
    _ops.add(
      _TextOp(
        x: x ?? _left,
        y: baseline - ascent,
        painter: painter,
        alignRight: alignRight,
      ),
    );
  }

  void _line(
    String value,
    double size, {
    FontWeight weight = FontWeight.w400,
    Color? fill,
    double? lh,
  }) {
    _emit(
      value,
      size,
      weight,
      fill ?? tokens.textPrimary,
      _top + size * _ascentShare,
    );
    _top += lh ?? (size * 1.34).roundToDouble();
  }

  /// A ranked-section header: uppercase, 800, in the tier colour.
  void _label(String value) {
    _line(
      value.toUpperCase(),
      8.5,
      weight: FontWeight.w800,
      fill: _tierAccent,
      lh: 12,
    );
    _top += 2;
  }

  void _rect(
    double x,
    double y,
    double w,
    double h,
    Color fill,
    double radius, {
    Color? stroke,
  }) {
    _ops.add(_RectOp(Rect.fromLTWH(x, y, w, h), fill, radius, stroke));
  }

  /// Word wrap, tokdash's rule: break on whitespace, never mid-word.
  List<String> _wrap(String value, TextStyle style) {
    final lines = <String>[];
    var line = '';
    for (final word in value.split(RegExp(r'\s+'))) {
      if (word.isEmpty) continue;
      final next = line.isEmpty ? word : '$line $word';
      if (line.isNotEmpty && _measure(next, style) > _contentWidth) {
        lines.add(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line.isNotEmpty) lines.add(line);
    return lines;
  }

  /// Ellipsis clip, tokdash's rule: truncate to fit, then add `…`.
  String _clip(String value, TextStyle style, double maxWidth) {
    if (_measure(value, style) <= maxWidth) return value;
    var out = value;
    while (out.length > 1 && _measure('$out…', style) > maxWidth) {
      out = out.substring(0, out.length - 1);
    }
    return '$out…';
  }

  UsageExportCardPlan build() {
    final costOn = includeCost && !report.isEmpty;

    // The eyebrow IS the privacy statement: which tier, in its colour.
    _line(
      kind.carriesProjectNames
          ? l10n.usageCardTierProjects
          : l10n.usageCardTierOverview,
      9,
      weight: FontWeight.w800,
      fill: _tierAccent,
      lh: 12,
    );
    _line(
      _clip(
        _title(),
        _style(20, FontWeight.w800, tokens.textPrimary),
        _contentWidth,
      ),
      20,
      weight: FontWeight.w800,
      lh: 24,
    );
    final rangeStyle = _style(10, FontWeight.w400, tokens.textSecondary);
    for (final row in _wrap(_rangeLine(), rangeStyle)) {
      _line(row, 10, fill: tokens.textSecondary, lh: 13);
    }
    _top += 5;

    _hero(costOn);
    _top += 7;
    _heat();
    _stats(costOn);
    _top += 4;
    _rankings();
    if (kind.carriesProjectNames) _projects();

    return UsageExportCardPlan._(
      background: tokens.canvas,
      maxProjects: maxProjects,
      cellCap: cellCap,
      used: _top,
      ops: List.unmodifiable(_ops),
      icons: List.unmodifiable(_icons),
      heatCells: _heatCells,
      heatLeft: _heatLeft,
      heatRight: _heatRight,
    );
  }

  String _title() {
    final from = DateTime.tryParse(report.range.from);
    if (from == null) return l10n.usageHubTileTitle;
    switch (period) {
      case UsagePeriod.year:
        // A completed year is just its number; "year to date" only fits the
        // one still running.
        if (report.range.to == '${from.year}-12-31') return '${from.year}';
        return l10n.usageCardPeriodYtd('${from.year}');
      case UsagePeriod.week:
        return l10n.usageCardWeekTitle(DateFormat.yMMMd(locale).format(from));
      case UsagePeriod.month:
        // A month needs no copy key: every locale already names it.
        return DateFormat.yMMMM(locale).format(from);
      case UsagePeriod.allTime:
        return l10n.usagePeriodAllTime;
      case UsagePeriod.today:
        // The report never offers `today`; the branch exists so adding a
        // period later is a compile error rather than a silently wrong title.
        return l10n.usagePeriodToday;
    }
  }

  String _rangeLine() {
    final from = DateTime.tryParse(report.range.from);
    final to = DateTime.tryParse(report.range.to);
    if (from == null || to == null) {
      return l10n.usageCardRange(report.range.from, report.range.to);
    }
    final format = DateFormat.yMMMd(locale);
    return l10n.usageCardRange(format.format(from), format.format(to));
  }

  void _hero(bool costOn) {
    final hero = report.isEmpty
        ? _em
        : formatUsageCardTokens(report.totals.tokens, locale: locale);
    // Tokens and cost share the hero line, the cost in the theme's cost
    // colour — the two figures a shared card is read for.
    final heroCost = costOn
        ? ' · ${formatUsageCardCost(report.totals.cost)}'
        : '';
    var heroSize = 34.0;
    while (heroSize > 20 &&
        _measure(
              hero + heroCost,
              _style(heroSize, FontWeight.w800, tokens.accent),
            ) >
            _contentWidth) {
      heroSize -= 1;
    }
    final baseline = _top + heroSize * _ascentShare;
    _emit(hero, heroSize, FontWeight.w800, tokens.accent, baseline);
    if (heroCost.isNotEmpty) {
      final heroWidth = _measure(
        hero,
        _style(heroSize, FontWeight.w800, tokens.accent),
      );
      _emit(
        heroCost,
        heroSize,
        FontWeight.w800,
        tokens.costInk,
        baseline,
        x: _left + heroWidth,
      );
    }
    _top += heroSize + 4;

    // One wrapped line carries the whole activity summary: days active,
    // sessions, requests, and the PARALLEL agent time. Each missing facet is
    // an em dash in its own slot, never a zero.
    final streaks = report.streaks;
    final sessions = usageExportSessionCount(report);
    final agentMs = report.activeTime?.activeMsSum;
    final totalDays = streaks?.totalDays ?? report.range.days;
    final subStyle = _style(11.5, FontWeight.w700, tokens.textSecondary);
    final sub = l10n.usageCardHeroSub(
      streaks?.activeDays?.toString() ?? _em,
      totalDays?.toString() ?? _em,
      sessions == null ? _em : formatUsageCount(sessions, locale: locale),
      formatUsageCount(report.totals.requests, locale: locale),
      agentMs == null ? _em : formatUsageCardDuration(agentMs, locale: locale),
    );
    for (final row in _wrap(sub, subStyle)) {
      _line(
        row,
        11.5,
        weight: FontWeight.w700,
        fill: tokens.textSecondary,
        lh: 15,
      );
    }
  }

  /// The heat block. The week card carries none: one row of seven stretched
  /// cells reads as a loading artifact, not a map. Days past the served window
  /// (the month's unelapsed tail, extended to the calendar month end) paint as
  /// empty outlined boxes, the same convention as the report page, so card and
  /// page never disagree. Shading is the served quartile `intensity`, the same
  /// rank the page's heatmap uses.
  void _heat() {
    if (period == UsagePeriod.week || period == UsagePeriod.today) return;
    final from = DateTime.tryParse(report.range.from);
    final servedTo = DateTime.tryParse(report.range.to);
    if (from == null || servedTo == null) return;
    final to = period == UsagePeriod.month
        ? DateTime(servedTo.year, servedTo.month + 1, 0)
        : servedTo;
    final start = DateTime.utc(from.year, from.month, from.day);
    final end = DateTime.utc(to.year, to.month, to.day);
    final windowEnd = DateTime.utc(servedTo.year, servedTo.month, servedTo.day);
    if (end.isBefore(start)) return;
    final dayCount = end.difference(start).inDays + 1;
    final lead = start.weekday - 1; // Monday-first
    final intensity = {
      for (final day in report.daily ?? const <UsageReportDay>[])
        if (day.intensity != null) day.date: day.intensity!,
    };

    String key(DateTime day) =>
        '${day.year.toString().padLeft(4, '0')}-'
        '${day.month.toString().padLeft(2, '0')}-'
        '${day.day.toString().padLeft(2, '0')}';

    void cell(double x, double y, double size, DateTime day, double radius) {
      _heatCells += 1;
      _heatLeft = math.min(_heatLeft ?? double.infinity, x);
      _heatRight = math.max(_heatRight ?? 0, x + size);
      final future = day.isAfter(windowEnd);
      _rect(
        x,
        y,
        size,
        size,
        future
            ? UsageHeatmap.intensityFill(tokens, 0)
            : UsageHeatmap.intensityFill(tokens, intensity[key(day)] ?? 0),
        radius,
        stroke: future ? tokens.separator : null,
      );
    }

    final heatTop = _top;
    final double heatH;
    if (dayCount <= 42) {
      // Month: square cells on the weekday grid, pinned to the left edge like
      // every other line on the card, and kept small so the rankings stay on
      // the card. `cellCap` still shrinks it when the card runs tight.
      final rows = ((lead + dayCount) / 7).ceil();
      const gap = 6.0;
      final size = math.max<double>(8, math.min<double>(16, cellCap + 5));
      final radius = math.min<double>(4, size / 4);
      for (var slot = lead; slot < lead + dayCount; slot++) {
        final col = slot % 7;
        final row = slot ~/ 7;
        cell(
          _left + col * (size + gap),
          heatTop + row * (size + gap),
          size,
          start.add(Duration(days: slot - lead)),
          radius,
        );
      }
      heatH = rows * size + (rows - 1) * gap;
    } else {
      // Year and all time: seven rows, a column per week. The gap is solved
      // after the cell, so the grid's right edge lands exactly on the content
      // edge.
      final cols = ((lead + dayCount) / 7).ceil();
      final size = math.max<double>(
        3,
        math.min<double>(
          cellCap,
          ((_contentWidth - 2.5 * (cols - 1)) / math.max(1, cols))
              .floorToDouble(),
        ),
      );
      final gap = cols > 1 ? (_contentWidth - cols * size) / (cols - 1) : 0;
      final radius = math.min<double>(2, size / 3);
      for (var col = 0; col < cols; col++) {
        for (var row = 0; row < 7; row++) {
          final index = col * 7 + row - lead;
          if (index < 0 || index >= dayCount) continue;
          cell(
            _left + col * (size + gap),
            heatTop + row * (size + gap),
            size,
            start.add(Duration(days: index)),
            radius,
          );
        }
      }
      heatH = 7 * size + 6 * gap;
    }
    _top = heatTop + heatH + (heatH > 0 ? 12 : 0);
  }

  void _stats(bool costOn) {
    void statRow(String label, String value) {
      final baseline = _top + 11 * _ascentShare;
      _emit(label, 11, FontWeight.w400, tokens.textSecondary, baseline);
      _emit(
        value,
        11,
        FontWeight.w800,
        tokens.textPrimary,
        baseline,
        x: _right,
        alignRight: true,
      );
      _top += 16;
    }

    // Days active and agent time moved into the hero sub; what stays here is
    // what a skim reads as a table: the peak day, and the cost repeat.
    final busiest = report.firsts?.busiestDay;
    final busiestDate = busiest == null ? null : DateTime.tryParse(busiest);
    statRow(
      l10n.usageCardBusiestLabel,
      busiestDate == null
          ? _em
          : '${DateFormat.MMMd(locale).format(busiestDate)}'
                ' · ${formatUsageCardTokens(
                  report.firsts?.busiestDayTokens ?? 0,
                  locale: locale,
                )}',
    );
    if (costOn) {
      statRow(l10n.usageCostLabel, formatUsageCardCost(report.totals.cost));
    }
  }

  void _rankRow({
    required String name,
    required String value,
    required double bar,
    String? tool,
    Color? barFill,
  }) {
    final iconWidth = tool == null ? 0.0 : 19.0;
    final valueStyle = _style(11, FontWeight.w800, tokens.textPrimary);
    final valuePainter = _painter(value, valueStyle);
    final valueWidth = valuePainter.width + 2;
    final baseline = _top + 11 * _ascentShare;
    if (tool != null) {
      _icons.add(UsageExportCardIconSpot(x: _left, y: _top - 1, tool: tool));
    }
    _emit(
      _clip(
        name,
        _style(11, FontWeight.w700, tokens.textPrimary),
        _contentWidth - iconWidth - valueWidth - 6,
      ),
      11,
      FontWeight.w700,
      tokens.textPrimary,
      baseline,
      x: _left + iconWidth,
    );
    _ops.add(
      _TextOp(
        x: _right,
        y: baseline - valuePainter.computeLineMetrics().first.ascent,
        painter: valuePainter,
        alignRight: true,
      ),
    );
    _top += 15;
    _rect(_left, _top, _contentWidth, 3, tokens.surface2, 1.5);
    _rect(
      _left,
      _top,
      math.max(2, _contentWidth * bar),
      3,
      barFill ?? tokens.accent,
      1.5,
    );
    _top += 8;
  }

  void _rankings() {
    final total = report.totals.tokens;
    String shareValue(double tokens) =>
        '${formatUsageCardTokens(tokens, locale: locale)}'
        ' · '
        '${formatUsageCardShare(
          total <= 0 ? null : tokens / total,
          locale: locale,
        )}';

    if (report.tools.isNotEmpty) {
      _label(l10n.usageRankHarnesses);
      final leaders = report.tools.take(3).toList();
      for (final tool in leaders) {
        _rankRow(
          tool: tool.tool,
          name: tool.label ?? tool.tool,
          value: shareValue(tool.tokens),
          bar:
              tool.tokens /
              (leaders.first.tokens <= 0 ? 1 : leaders.first.tokens),
        );
      }
      _top += 2;
    }
    if (report.topModelsByTokens.isNotEmpty) {
      _label(l10n.usageRankModels);
      final leaders = report.topModelsByTokens.take(3).toList();
      for (final model in leaders) {
        _rankRow(
          name: model.name,
          value: shareValue(model.tokens),
          bar:
              model.tokens /
              (leaders.first.tokens <= 0 ? 1 : leaders.first.tokens),
        );
      }
      _top += 2;
    }
  }

  void _projects() {
    _label(l10n.usageCardRankProjects);
    final projects = report.projects;
    if (projects == null || projects.rows.isEmpty) {
      // Said, not silently empty: a missing facet is a fact about the server,
      // not a claim that no projects exist.
      _line(l10n.usageCardMissingProjects, 10, fill: tokens.textSecondary);
      return;
    }
    final leaders = projects.rows.take(maxProjects).toList();
    final total = report.totals.tokens;
    for (final row in leaders) {
      _rankRow(
        name: row.project,
        value:
            '${formatUsageCardTokens(row.tokens, locale: locale)}'
            ' · '
            '${formatUsageCardShare(
              total <= 0 ? null : row.tokens / total,
              locale: locale,
            )}',
        bar:
            row.tokens / (leaders.first.tokens <= 0 ? 1 : leaders.first.tokens),
        barFill: _tierAccent,
      );
    }
  }
}

/// A shareable summary of the period, rendered for capture.
///
/// Laid out by [UsageExportCardPlan.fit], the tokdash card geometry ported to
/// this client's theme tokens: 360×640 logical, 24px gutters, the eyebrow and
/// section labels in the tier colour, heat cells shaded by the served
/// intensity exactly as the report page's heatmap shades them.
class UsageExportCard extends StatelessWidget {
  /// Creates an export card.
  const UsageExportCard({
    required this.kind,
    required this.period,
    required this.report,
    required this.locale,
    required this.includeCost,
    super.key,
  });

  /// Which card this is.
  final UsageExportCardKind kind;

  /// The period the report covers; titles and the heat layout follow it.
  final UsagePeriod period;

  /// The served report for the card's window.
  final UsageReport report;

  /// BCP-47 tag for figure formatting.
  final String locale;

  /// Whether to print the cost figure. Off by default; the qualifier that
  /// says what the figure is lives on the page's toggle, not on the image.
  final bool includeCost;

  @override
  Widget build(BuildContext context) {
    final plan = UsageExportCardPlan.fit(
      kind: kind,
      period: period,
      report: report,
      locale: locale,
      includeCost: includeCost,
      l10n: AppLocalizations.of(context),
      tokens: context.tokens,
      baseStyle: Theme.of(context).textTheme.bodySmall!,
    );
    return SizedBox(
      width: usageExportCardWidth,
      height: usageExportCardHeight,
      child: ColoredBox(
        color: plan.background,
        child: Stack(
          children: [
            Positioned.fill(
              child: CustomPaint(painter: _UsageExportCardPainter(plan)),
            ),
            for (final spot in plan.icons)
              Positioned(
                left: spot.x,
                top: spot.y,
                width: 15,
                height: 15,
                child: UsageAgentLogo(tool: spot.tool, size: 15),
              ),
          ],
        ),
      ),
    );
  }
}

class _UsageExportCardPainter extends CustomPainter {
  _UsageExportCardPainter(this._plan);

  final UsageExportCardPlan _plan;

  @override
  void paint(Canvas canvas, Size size) {
    for (final op in _plan.ops) {
      switch (op) {
        case final _RectOp rect:
          final paint = Paint()..color = rect.fill;
          final rrect = RRect.fromRectAndRadius(
            rect.rect,
            Radius.circular(rect.radius),
          );
          canvas.drawRRect(rrect, paint);
          final stroke = rect.stroke;
          if (stroke != null) {
            canvas.drawRRect(
              rrect,
              Paint()
                ..color = stroke
                ..style = PaintingStyle.stroke
                ..strokeWidth = 0.8,
            );
          }
        case final _TextOp text:
          text.painter.paint(
            canvas,
            Offset(
              text.alignRight ? text.x - text.painter.width : text.x,
              text.y,
            ),
          );
      }
    }
  }

  @override
  bool shouldRepaint(_UsageExportCardPainter oldDelegate) =>
      !identical(oldDelegate._plan, _plan);
}

/// Sessions for the card hero, or `null` when nothing served a count.
int? usageExportSessionCount(UsageReport report) {
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
