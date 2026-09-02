import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/window_size_class.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_report_api.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_format.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_period.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_agent_table.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_figures.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_heatmap.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_hero.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_podium.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_share_section.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_when_you_work.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

/// Settings → Usage overview: what this machine actually did.
///
/// Scope is the machine, never "your cosyncing sessions": the broker host's
/// tokdash sees every agent on it, and cosyncing adapts a subset. The page says
/// so in a subtitle that is not optional.
class UsageReportPage extends ConsumerStatefulWidget {
  /// Creates the usage report page.
  const UsageReportPage({this.initialPeriod, super.key});

  /// The period to open on. Defaults to the month.
  ///
  /// Set from the route's `?period=` so a link can name the period it means —
  /// a month-end notification opening on the month it is about, rather than on
  /// whatever the page's default happens to be.
  final UsagePeriod? initialPeriod;

  @override
  ConsumerState<UsageReportPage> createState() => _UsageReportPageState();
}

class _UsageReportPageState extends ConsumerState<UsageReportPage> {
  late UsagePeriod _period = widget.initialPeriod ?? UsagePeriod.month;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final report = ref.watch(usageReportProvider(_period));

    return Scaffold(
      appBar: AppBar(title: Text(l10n.usageHubTileTitle)),
      body: SafeArea(
        child: Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            // The report is a reading surface: past ~880 it becomes a wide
            // sparse band rather than a denser page.
            constraints: const BoxConstraints(maxWidth: 880),
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                _PeriodSwitcher(
                  period: _period,
                  onChanged: (value) => setState(() => _period = value),
                ),
                const SizedBox(height: 16),
                report.when(
                  loading: () => InlineNotice(
                    text: l10n.usageLoading,
                    showSpinner: true,
                  ),
                  error: (error, _) => InlineNotice(
                    icon: Icons.cloud_off_outlined,
                    text: l10n.usageUnavailable,
                  ),
                  data: (response) =>
                      _UsageReportBody(period: _period, response: response),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _PeriodSwitcher extends StatelessWidget {
  const _PeriodSwitcher({required this.period, required this.onChanged});

  final UsagePeriod period;
  final ValueChanged<UsagePeriod> onChanged;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Align(
      alignment: Alignment.centerLeft,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: SegmentedButton<UsagePeriod>(
          key: const Key('usage-period-switcher'),
          showSelectedIcon: false,
          segments: [
            for (final value in UsagePeriod.report)
              ButtonSegment(
                value: value,
                label: Text(usagePeriodLabel(l10n, value)),
              ),
          ],
          selected: {period},
          onSelectionChanged: (selection) => onChanged(selection.first),
        ),
      ),
    );
  }
}

/// The localized name of a period segment.
///
/// The two surfaces label the same periods differently — the card says "This
/// week" beside "Today", the report says "Week" beside "Year" — so the labels
/// are separate keys over one vocabulary rather than one key reused at two
/// meanings.
String usagePeriodLabel(AppLocalizations l10n, UsagePeriod period) {
  return switch (period) {
    UsagePeriod.today => l10n.usagePeriodToday,
    UsagePeriod.week => l10n.usagePeriodWeek,
    UsagePeriod.month => l10n.usagePeriodMonth,
    UsagePeriod.year => l10n.usagePeriodYear,
    UsagePeriod.allTime => l10n.usagePeriodAllTime,
  };
}

/// The card's own labels for the periods it offers.
String usageCardPeriodLabel(AppLocalizations l10n, UsagePeriod period) {
  return switch (period) {
    UsagePeriod.today => l10n.usagePeriodToday,
    UsagePeriod.week => l10n.usagePeriodThisWeek,
    UsagePeriod.month => l10n.usagePeriodThisMonth,
    UsagePeriod.year => l10n.usagePeriodYear,
    UsagePeriod.allTime => l10n.usagePeriodAllTime,
  };
}

/// A human name for the window a report actually covers.
///
/// Built from the served `range`, never from the period that was asked for: an
/// unrecognized period resolves to all time upstream, and a title taken from
/// the request would then label a decade as "this week".
String usageWindowTitle(
  AppLocalizations l10n,
  UsagePeriod period,
  UsageReportRange range,
  String locale,
) {
  final from = DateTime.tryParse(range.from);
  if (from == null) return usagePeriodLabel(l10n, period);
  return switch (period) {
    UsagePeriod.month => DateFormat.yMMMM(locale).format(from),
    UsagePeriod.year => DateFormat.y(locale).format(from),
    _ => usagePeriodLabel(l10n, period),
  };
}

/// The first day the activity grid should draw.
///
/// The later of the served window's start and the first day with a served row.
/// A window whose start predates every record — all-time always does — would
/// otherwise draw one column per week back to the requested floor.
///
/// Falls back to the requested start when nothing is served, which keeps an
/// empty window rendering as the window it asked for rather than as nothing.
DateTime usageHeatmapStart(DateTime requestedFrom, UsageReport report) {
  DateTime? earliest;
  for (final day in report.daily ?? const <UsageReportDay>[]) {
    final parsed = DateTime.tryParse(day.date);
    if (parsed == null) continue;
    if (earliest == null || parsed.isBefore(earliest)) earliest = parsed;
  }
  final firstActive = DateTime.tryParse(report.firsts?.firstActiveDay ?? '');
  if (firstActive != null &&
      (earliest == null || firstActive.isBefore(earliest))) {
    earliest = firstActive;
  }
  if (earliest == null || earliest.isBefore(requestedFrom)) {
    return requestedFrom;
  }
  return earliest;
}

class _UsageReportBody extends StatelessWidget {
  const _UsageReportBody({required this.period, required this.response});

  final UsagePeriod period;
  final UsageReportResponse? response;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final report = response?.report;

    // `null` is unavailable, not empty. A zero here would tell the user they
    // did no work, which is a different claim and never the true one.
    if (report == null) {
      return InlineNotice(
        icon: Icons.cloud_off_outlined,
        text: l10n.usageUnavailable,
      );
    }
    // An unrecognized window silently resolved to all time upstream, so every
    // figure below it would be true of a period nobody asked about. Said in its
    // own words: the report arrived, and it is this period that could not be
    // resolved — which is a different thing from Tokdash being unreachable, and
    // the reader's next move differs accordingly.
    if (!report.range.recognized) {
      return InlineNotice(
        icon: Icons.help_outline,
        text: l10n.usageWindowUnrecognized,
      );
    }

    final locale = Localizations.localeOf(context).toLanguageTag();
    final active = report.activeTime;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _Header(period: period, report: report, locale: locale),
        const SizedBox(height: 16),
        if (report.isPartial) ...[
          InlineNotice(
            icon: Icons.warning_amber_outlined,
            text: l10n.usagePartial(report.sourceErrors.join(', ')),
          ),
          const SizedBox(height: 16),
        ],
        if (report.isEmpty)
          InlineNotice(
            icon: Icons.inbox_outlined,
            text: l10n.usageEmptyPeriod(
              usagePeriodLabel(l10n, period).toLowerCase(),
            ),
          )
        else ...[
          UsageHero(
            period: period,
            report: report,
            periodLabel: usageWindowTitle(l10n, period, report.range, locale),
            locale: locale,
            activeTimeTooltip: active == null
                ? null
                : usageEstimatedTip(l10n, active),
          ),
          const SizedBox(height: 24),
          _ActiveDays(report: report, locale: locale),
          const SizedBox(height: 24),
          UsagePodium(period: period, report: report, locale: locale),
          const SizedBox(height: 24),
          UsageWhenYouWork(
            hourly: report.hourly,
            weekday: report.weekday,
            timezone: report.timezone,
            locale: locale,
          ),
          const SizedBox(height: 24),
          UsageAgentTable(tools: report.tools, locale: locale),
          const SizedBox(height: 24),
          UsageShareSection(report: report, locale: locale),
        ],
        const SizedBox(height: 24),
        _Footer(report: report, locale: locale),
      ],
    );
  }
}

/// The heatmap, its legend, and the one line of streak evidence beneath it.
class _ActiveDays extends StatelessWidget {
  const _ActiveDays({required this.report, required this.locale});

  final UsageReport report;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final daily = report.daily;
    if (daily == null || daily.isEmpty) return const SizedBox.shrink();

    final requestedFrom = DateTime.tryParse(report.range.from);
    final to = DateTime.tryParse(report.range.to);
    if (requestedFrom == null || to == null) return const SizedBox.shrink();

    // The grid starts where the data does, not where the request did.
    //
    // All-time asks from `usageAllTimeFloor`, and tokdash echoes it: a live
    // all-time window answers `from: 2000-01-01` with `days: 9742` and 233
    // daily rows. Drawn from the requested day that is ~1,392 non-lazy week
    // columns, 97% of them holes, and the reader scrolls a quarter century of
    // empty weeks to reach their own history. The header still prints the
    // window that was asked for; only the grid is trimmed to what exists.
    final from = usageHeatmapStart(requestedFrom, report);

    final compact = WindowSizeClass.of(context) == WindowSizeClass.compact;
    // A year of week columns will not fit any phone, so the cells shrink with
    // the window rather than the grid dropping weeks it cannot show.
    final wide = to.difference(from).inDays > 120;
    final cellSize = wide ? (compact ? 5.0 : 7.0) : (compact ? 10.0 : 12.0);

    // "Still running" is decided against the served window's own end, not the
    // client clock's idea of the period.
    final today = DateTime.now();
    final windowIsOpen = !to.isBefore(
      DateTime(today.year, today.month, today.day),
    );
    final streak = _streakLine(
      l10n,
      report,
      locale,
      windowIsOpen: windowIsOpen,
    );
    return Column(
      key: const Key('usage-report-active-days'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        UsageSectionTitle(title: l10n.usageActiveDaysTitle),
        UsageHeatmap(
          from: from,
          to: to,
          intensityByDate: {
            for (final day in daily)
              if (day.intensity != null) day.date: day.intensity!,
          },
          cellSize: cellSize,
          gap: wide ? 2 : 3,
          weekdayLabels: _weekdayLabels(locale, sparse: compact || wide),
        ),
        const SizedBox(height: 8),
        UsageHeatmapLegend(
          lessLabel: l10n.usageLegendLess,
          moreLabel: l10n.usageLegendMore,
        ),
        if (streak != null) ...[
          const SizedBox(height: 8),
          Text(
            streak,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: context.tokens.textSecondary,
            ),
          ),
        ],
      ],
    );
  }

  /// Mon/Wed/Fri only where a full gutter would not fit.
  static Map<int, String> _weekdayLabels(
    String locale, {
    required bool sparse,
  }) {
    const shown = [1, 3, 5];
    return {
      for (var weekday = 1; weekday <= 7; weekday++)
        if (!sparse || shown.contains(weekday))
          weekday: usageWeekdayName(weekday - 1, locale, const []),
    };
  }

  /// The line under the heatmap, degrading rather than inventing a figure.
  ///
  /// The streak clause only appears on a window that is still running. The
  /// facet's `currentStreak` is a fact about *today*; printing it beside a
  /// closed August would attach a number to a window it does not describe —
  /// and a served `0` beside "31 of 31 days active" reads as a contradiction
  /// rather than as two different measurements.
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

class _Header extends StatelessWidget {
  const _Header({
    required this.period,
    required this.report,
    required this.locale,
  });

  final UsagePeriod period;
  final UsageReport report;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final window = report.range;

    final suffixes = <String>[];
    final days = window.days;
    final firsts = report.firsts;
    // In progress is derived from the served window against its own last active
    // day, so a closed period never claims to still be running.
    if (days != null && firsts?.lastActiveDay != null) {
      final last = DateTime.tryParse(firsts!.lastActiveDay!);
      final to = DateTime.tryParse(window.to);
      if (last != null && to != null && !last.isBefore(to)) {
        final elapsed = resolveUsageWindow(period, DateTime.now());
        if (elapsed.inProgress) {
          suffixes.add(
            l10n.usageInProgress(elapsed.elapsedDays, elapsed.totalDays!),
          );
        }
      }
    }
    final timezone = report.timezone;
    if (timezone != null) suffixes.add(l10n.usageBrokerTime(timezone));

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          l10n.usageReportTitle(
            usageWindowTitle(l10n, period, window, locale),
          ),
          key: const Key('usage-report-title'),
          style: theme.textTheme.titleMedium,
        ),
        if (suffixes.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(
              suffixes.join(' '),
              style: theme.textTheme.bodySmall?.copyWith(
                color: tokens.textTertiary,
              ),
            ),
          ),
        const SizedBox(height: 4),
        // The explicit range, always. A period name alone lets "Year" imply
        // twelve months over a window that opened in March.
        Text(
          l10n.usageWindowRange(window.from, window.to),
          style: theme.textTheme.bodySmall?.copyWith(
            color: tokens.textTertiary,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
        const SizedBox(height: 8),
        Text(
          l10n.usageReportScope,
          key: const Key('usage-report-scope'),
          style: theme.textTheme.bodySmall?.copyWith(
            color: tokens.textTertiary,
          ),
        ),
      ],
    );
  }
}

/// The in/out/cache split, or `null` when the broker served no split.
String? usageTokenBreakdownText(
  AppLocalizations l10n,
  UsageReportTotals totals,
  String locale,
) {
  final input = totals.tokensIn;
  final output = totals.tokensOut;
  final cache = totals.tokensCache;
  if (input == null || output == null || cache == null) return null;
  return l10n.usageTokenBreakdown(
    formatCompactCount(input, locale: locale),
    formatCompactCount(output, locale: locale),
    formatCompactCount(cache, locale: locale),
  );
}

/// How the agent-time estimate is made, using the served idle-gap cap.
String usageEstimatedTip(AppLocalizations l10n, UsageReportActiveTime active) =>
    l10n.usageActiveEstimatedTip(usageIdleGapMinutes(active));

/// The served idle-gap cap in whole minutes.
///
/// Falls back to five only because that is Tokdash's own default; the served
/// value wins whenever there is one, so the note never states a rule the
/// broker is not actually applying.
int usageIdleGapMinutes(UsageReportActiveTime active) {
  final cap = active.gapCapMs;
  return cap == null ? 5 : (cap / Duration.millisecondsPerMinute).round();
}

class _Footer extends StatelessWidget {
  const _Footer({required this.report, required this.locale});

  final UsageReport report;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final active = report.activeTime;
    final notes = <String>[
      l10n.usageDayBoundaryNote,
      l10n.usageCostFooterNote,
      if (active != null)
        l10n.usageActiveTimeNote(usageIdleGapMinutes(active).toString()),
      if (report.coverage != null)
        l10n.usageSourceCount(report.coverage!.sourceCount),
    ];
    return UsageFootnote(text: notes.join(' · '), center: true);
  }
}
