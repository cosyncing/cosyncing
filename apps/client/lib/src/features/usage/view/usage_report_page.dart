import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_report_api.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_format.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_period.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_activity.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_agent_table.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_hero.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_podium.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_share_section.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_when_you_work.dart';
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';

/// Settings → Usage overview: what this machine actually did.
///
/// Scope is the machine, never "your cosyncing sessions": the broker host's
/// tokdash sees every agent on it, and cosyncing adapts a subset.
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

  /// How many complete periods back the page is looking. Switching the period
  /// segment always lands back on the period in progress.
  int _offset = 0;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final report = ref.watch(
      usageReportProvider((period: _period, offset: _offset)),
    );

    return Scaffold(
      appBar: AppBar(title: Text(l10n.usageHubTileTitle)),
      body: SafeArea(
        child: Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            // The report is a reading surface: past ~880 it becomes a wide
            // sparse band rather than a denser page.
            constraints: const BoxConstraints(maxWidth: 1100),
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                _PeriodSwitcher(
                  period: _period,
                  offset: _offset,
                  onChanged: (value) => setState(() {
                    _period = value;
                    _offset = 0;
                  }),
                  onOffsetChanged: (value) => setState(() => _offset = value),
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
                  data: (response) => _UsageReportBody(
                    period: _period,
                    offset: _offset,
                    response: response,
                    now: ref.watch(usageNowProvider)(),
                  ),
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
  const _PeriodSwitcher({
    required this.period,
    required this.offset,
    required this.onChanged,
    required this.onOffsetChanged,
  });

  final UsagePeriod period;
  final int offset;
  final ValueChanged<UsagePeriod> onChanged;
  final ValueChanged<int> onOffsetChanged;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final label = usagePeriodLabel(l10n, period).toLowerCase();
    final navigable = period != UsagePeriod.allTime;
    final periods = SegmentedButton<UsagePeriod>(
      key: const Key('usage-period-switcher'),
      showSelectedIcon: false,
      expandedInsets: EdgeInsets.zero,
      style: ButtonStyle(
        padding: const WidgetStatePropertyAll(
          EdgeInsets.symmetric(horizontal: 8),
        ),
        textStyle: WidgetStatePropertyAll(
          Theme.of(context).textTheme.labelMedium,
        ),
        minimumSize: const WidgetStatePropertyAll(Size(0, 40)),
      ),
      segments: [
        for (final value in UsagePeriod.report)
          ButtonSegment(
            value: value,
            label: Text(usagePeriodLabel(l10n, value)),
          ),
      ],
      selected: {period},
      onSelectionChanged: (selection) => onChanged(selection.first),
    );
    final navigation = Visibility(
      visible: navigable,
      maintainState: true,
      maintainAnimation: true,
      maintainSize: true,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(
            key: const Key('usage-period-previous'),
            icon: const Icon(Icons.chevron_left),
            tooltip: l10n.usagePeriodPrevious(label),
            onPressed: () => onOffsetChanged(offset + 1),
          ),
          Flexible(
            child: TextButton(
              key: const Key('usage-period-current'),
              onPressed: offset == 0 ? null : () => onOffsetChanged(0),
              child: Text(
                l10n.usageEnhancementCurrent,
                textAlign: TextAlign.center,
              ),
            ),
          ),
          IconButton(
            key: const Key('usage-period-next'),
            icon: const Icon(Icons.chevron_right),
            tooltip: l10n.usagePeriodNext(label),
            onPressed: offset == 0 ? null : () => onOffsetChanged(offset - 1),
          ),
        ],
      ),
    );
    return LayoutBuilder(
      builder: (context, constraints) {
        if (constraints.maxWidth < 520) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [periods, const SizedBox(height: 4), navigation],
          );
        }
        return Row(
          children: [
            Flexible(child: periods),
            const SizedBox(width: 16),
            ConstrainedBox(
              constraints: BoxConstraints(maxWidth: constraints.maxWidth / 2),
              child: navigation,
            ),
          ],
        );
      },
    );
  }
}

/// The localized name of a period segment.
String usagePeriodLabel(AppLocalizations l10n, UsagePeriod period) {
  return switch (period) {
    UsagePeriod.today => l10n.usageEnhancementDay,
    UsagePeriod.week => l10n.usagePeriodWeek,
    UsagePeriod.month => l10n.usagePeriodMonth,
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
    UsagePeriod.today => DateFormat.yMMMd(locale).format(from),
    UsagePeriod.month => DateFormat.yMMMM(locale).format(from),
    UsagePeriod.year => DateFormat.y(locale).format(from),
    _ => usagePeriodLabel(l10n, period),
  };
}

/// The first day an all-time activity grid should draw.
///
/// The later of the served window's start and the first day with a served row.
/// A window whose start predates every record — all-time always does — would
/// otherwise draw one column per week back to the requested floor.
///
/// Only all-time. For a bounded period the untouched days before the first
/// active one are days the report covered and the user was idle on, which the
/// grid draws as inactive cells and which streaks and the weekday facet are
/// built from. Trimming those would restate idleness as absence of coverage.
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

class _UsageReportBody extends StatefulWidget {
  const _UsageReportBody({
    required this.period,
    required this.offset,
    required this.response,
    required this.now,
  });

  final UsagePeriod period;

  /// How many complete periods back this window is. 0 is the one in progress.
  final int offset;
  final UsageReportResponse? response;

  /// The clock everything on the page resolves against.
  final DateTime now;

  @override
  State<_UsageReportBody> createState() => _UsageReportBodyState();
}

class _UsageReportBodyState extends State<_UsageReportBody> {
  final List<GlobalKey> sections = List.generate(5, (_) => GlobalKey());

  @override
  Widget build(BuildContext context) {
    final period = widget.period;
    final offset = widget.offset;
    final response = widget.response;
    final now = widget.now;
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
    // Ordered before the window verdict, and it has to be: a tokdash below the
    // report's floor never published `recognized` at all, so the verdict reads
    // false because the field is absent. Checking the window first told a
    // reader on an old tokdash that their period had been refused — a claim
    // nothing upstream made, and one that sends them to change the period
    // instead of the thing that is actually wrong.
    if (report.needsTokdashUpgrade) {
      return InlineNotice(
        icon: Icons.system_update_alt_outlined,
        text: usageTokdashUpgradeText(l10n, report.runtime),
      );
    }
    // An unrecognized window silently resolved to all time upstream, so every
    // figure below it would be true of a period nobody asked about. Said in its
    // own words: the report arrived, and it is this period that could not be
    // resolved — which is a different thing from Tokdash being unreachable, and
    // the reader's next move differs accordingly. Reached only on a tokdash
    // current enough to have refused the period on purpose.
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
        _Header(
          period: period,
          offset: offset,
          report: report,
          locale: locale,
          now: now,
        ),
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
          Wrap(
            spacing: 4,
            children: [
              for (final (index, title) in <(int, String)>[
                (0, l10n.usageShareTierOverviewChip),
                (1, l10n.usageEnhancementActivity),
                (2, l10n.usageEnhancementLeaders),
                (3, l10n.usageByAgent),
                (4, l10n.usageShareTitle),
              ])
                TextButton(
                  onPressed: () {
                    final target = sections[index].currentContext;
                    if (target != null) Scrollable.ensureVisible(target);
                  },
                  child: Text(title),
                ),
            ],
          ),
          const SizedBox(height: 12),
          UsageHero(
            key: sections[0],
            period: period,
            report: report,
            locale: locale,
            activeTimeTooltip: active == null
                ? null
                : usageEstimatedTip(l10n, active),
          ),
          const SizedBox(height: 24),
          UsageActivity(
            key: sections[1],
            period: period,
            report: report,
            locale: locale,
            now: now,
          ),
          const SizedBox(height: 24),
          UsagePodium(
            key: sections[2],
            period: period,
            report: report,
            locale: locale,
          ),
          const SizedBox(height: 24),
          _Staggered(
            frames: 1,
            child: UsageWhenYouWork(
              totalTokens: report.totals.tokens,
              hourly: report.hourly,
              showHourlyChart: period != UsagePeriod.today,
              showWeekday: period != UsagePeriod.today,
              weekday: report.weekday,
              timezone: report.timezone,
              locale: locale,
            ),
          ),
          const SizedBox(height: 24),
          _Staggered(
            frames: 2,
            child: UsageAgentTable(
              key: sections[3],
              tools: report.tools,
              locale: locale,
              range: report.range,
            ),
          ),
          const SizedBox(height: 24),
          _Staggered(
            frames: 3,
            child: UsageShareSection(
              key: sections[4],
              period: period,
              report: report,
              locale: locale,
            ),
          ),
        ],
      ],
    );
  }
}

/// Builds [child] [frames] frames after it first mounts.
///
/// Opening the report built every section in one frame, and the sections below
/// the fold (the agent table, and four share previews that each fit a card)
/// cost more than everything above it. Each now arrives in a frame of its own,
/// so the page appears at once and the rest follows while the top is read.
class _Staggered extends StatefulWidget {
  const _Staggered({required this.frames, required this.child});

  /// Frames to wait before building [child].
  final int frames;

  final Widget child;

  @override
  State<_Staggered> createState() => _StaggeredState();
}

class _StaggeredState extends State<_Staggered> {
  late int _remaining = widget.frames;

  @override
  void initState() {
    super.initState();
    if (_remaining > 0) _waitAFrame();
  }

  void _waitAFrame() {
    SchedulerBinding.instance
      ..addPostFrameCallback((_) {
        if (!mounted) return;
        setState(() => _remaining -= 1);
        if (_remaining > 0) _waitAFrame();
      })
      ..scheduleFrame();
  }

  @override
  Widget build(BuildContext context) =>
      _remaining > 0 ? const SizedBox.shrink() : widget.child;
}

class _Header extends ConsumerWidget {
  const _Header({
    required this.period,
    required this.offset,
    required this.report,
    required this.locale,
    required this.now,
  });

  final UsagePeriod period;
  final int offset;
  final UsageReport report;
  final String locale;

  /// The injected clock; the progress note must agree with the window the
  /// request was built from, which the raw wall clock need not do.
  final DateTime now;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final window = report.range;

    // In progress is derived from the served window against its own last active
    // day, so a closed period never claims to still be running. A stepped-back
    // window is complete by construction and never prints the note at all.
    String? progress;
    final days = window.days;
    final firsts = report.firsts;
    if (offset == 0 && days != null && firsts?.lastActiveDay != null) {
      final last = DateTime.tryParse(firsts!.lastActiveDay!);
      final to = DateTime.tryParse(window.to);
      if (last != null &&
          to != null &&
          !last.isBefore(to) &&
          !to.isBefore(DateTime(now.year, now.month, now.day))) {
        final elapsed = resolveUsageWindow(period, now);
        if (elapsed.inProgress) {
          progress = l10n.usageInProgress(
            elapsed.elapsedDays,
            elapsed.totalDays!,
          );
        }
      }
    }

    // One line: the progress note, then the explicit range. A period name
    // alone lets "Year" imply twelve months over a window that opened in
    // March, so the range is always printed — and the zone the buckets are
    // bucketed by is stated by `When you work`, which owns it.
    final line = [
      if (progress != null) progress,
      l10n.usageWindowRange(window.from, window.to),
      if (report.timezone != null) report.timezone!,
    ].join(' · ');

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
        const SizedBox(height: 4),
        Text(
          line,
          key: const Key('usage-report-range'),
          style: theme.textTheme.bodySmall?.copyWith(
            color: tokens.textTertiary,
            fontFeatures: const [FontFeature.tabularFigures()],
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

/// Why this report shows nothing, when the server's tokdash is too old for it.
///
/// Names both versions when both are known, because "too old" without either
/// number tells the reader nothing they can act on. A tokdash that will not
/// report its own version gets the second phrasing rather than a rendered
/// `null`: the floor is still a fact, the installed version is not.
///
/// Shared by the report page and the overview's usage summary so the two
/// cannot drift into describing the same host differently.
String usageTokdashUpgradeText(
  AppLocalizations l10n,
  UsageReportRuntime runtime,
) => runtime.hasVersion
    ? l10n.usageTokdashOutdated(runtime.version!, runtime.minimumVersion)
    : l10n.usageTokdashVersionUnknown(runtime.minimumVersion);

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
