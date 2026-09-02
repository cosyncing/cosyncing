import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_report_api.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_format.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_period.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_figures.dart';
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
  const UsageReportPage({super.key});

  @override
  ConsumerState<UsageReportPage> createState() => _UsageReportPageState();
}

class _UsageReportPageState extends ConsumerState<UsageReportPage> {
  UsagePeriod _period = UsagePeriod.month;

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
    // figure below it would be true of a period nobody asked about.
    if (!report.range.recognized) {
      return InlineNotice(
        icon: Icons.help_outline,
        text: l10n.usageUnavailable,
      );
    }

    final locale = Localizations.localeOf(context).toLanguageTag();
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
        else
          _Totals(report: report, locale: locale),
        const SizedBox(height: 24),
        _Footer(report: report, locale: locale),
      ],
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

class _Totals extends StatelessWidget {
  const _Totals({required this.report, required this.locale});

  final UsageReport report;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Column(
      key: const Key('usage-report-totals'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        UsageFigureRow(
          label: l10n.usageTokensLabel,
          value: formatCompactCount(report.totals.tokens, locale: locale),
          detail: usageTokenBreakdownText(l10n, report.totals, locale),
        ),
        UsageFigureRow(
          label: l10n.usageCostLabel,
          // Never bare: the qualifier is inside the string, so a future edit
          // cannot drop it and leave a figure that reads as money spent.
          value: l10n.usageCostQualified(
            formatUsageCost(report.totals.cost, locale: locale, compact: true),
          ),
        ),
        UsageFigureRow(
          label: l10n.usageRequestsLabel,
          value: formatCompactCount(report.totals.requests, locale: locale),
        ),
        if (report.activeTime?.activeMsSum != null)
          UsageFigureRow(
            label: l10n.usageAgentTimeLabel,
            value: l10n.usageHoursValue(
              formatUsageHours(
                report.activeTime!.activeMsSum!,
                locale: locale,
              ),
            ),
            tooltip: usageEstimatedTip(l10n, report.activeTime!),
            trailing: StatusPill(
              label: l10n.usageEstimated,
              color: context.tokens.statusIdle,
            ),
          ),
        if (report.topModelsByTokens.isNotEmpty)
          UsageFigureRow(
            label: l10n.usageTopModelLabel,
            value: report.topModelsByTokens.first.name,
            detail: report.totals.tokens > 0
                ? l10n.usageShareOfTokens(
                    formatUsageShare(
                      report.topModelsByTokens.first.tokens /
                          report.totals.tokens,
                      locale: locale,
                    ),
                  )
                : null,
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
String usageEstimatedTip(AppLocalizations l10n, UsageReportActiveTime active) {
  final cap = active.gapCapMs;
  final minutes = cap == null
      ? 5
      : (cap / Duration.millisecondsPerMinute).round();
  return l10n.usageActiveEstimatedTip(minutes);
}

class _Footer extends StatelessWidget {
  const _Footer({required this.report, required this.locale});

  final UsageReport report;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final notes = <String>[
      l10n.usageDayBoundaryNote,
      if (report.coverage != null)
        l10n.usageSourceCount(report.coverage!.sourceCount),
    ];
    return UsageFootnote(text: notes.join(' · '), center: true);
  }
}
