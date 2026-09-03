import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/window_size_class.dart';
import 'package:cosyncing_client/src/features/usage/data/usage_report_api.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_format.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_period.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_figures.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_report_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// What this machine did, in Settings → Agents & usage.
///
/// Deliberately a separate section above `QuotaStatusPanel` rather than a row
/// inside it. The two are never one figure and never one card: the quota panel
/// is a *window* — what is left before a limit resets — and this is a *sum* of
/// what happened. They sit adjacent and both say "usage", so a one-line
/// disambiguation rides between them at exactly the point the confusion would
/// occur.
class UsageTodayCard extends ConsumerStatefulWidget {
  /// Creates the usage card.
  const UsageTodayCard({super.key});

  @override
  ConsumerState<UsageTodayCard> createState() => _UsageTodayCardState();
}

class _UsageTodayCardState extends ConsumerState<UsageTodayCard> {
  UsagePeriod _period = UsagePeriod.today;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final report = ref.watch(usageReportProvider(_period));
    final window = resolveUsageWindow(_period, ref.watch(usageNowProvider)());
    final compact = WindowSizeClass.of(context) == WindowSizeClass.compact;

    return Column(
      key: const Key('settings-usage-card'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // The quota panel's own title treatment, so the two sections read as
        // siblings rather than one outranking the other.
        Text(
          l10n.usageTodayTitle,
          style: theme.textTheme.labelLarge?.copyWith(
            color: tokens.textSecondary,
          ),
        ),
        const SizedBox(height: 8),
        _CardPeriodSwitcher(
          period: _period,
          onChanged: (value) => setState(() => _period = value),
        ),
        if (window.inProgress) ...[
          const SizedBox(height: 6),
          UsageFootnote(
            text: l10n.usageInProgressNote(
              window.elapsedDays,
              window.totalDays!,
            ),
          ),
        ],
        const SizedBox(height: 12),
        report.when(
          loading: () =>
              InlineNotice(text: l10n.usageLoading, showSpinner: true),
          error: (error, _) => InlineNotice(
            icon: Icons.cloud_off_outlined,
            text: l10n.usageUnavailable,
          ),
          data: (response) => _CardBody(
            period: _period,
            response: response,
            compact: compact,
          ),
        ),
        const SizedBox(height: 12),
        // The cheapest possible guard against conflating a sum with a window,
        // placed between the two sections that invite it.
        UsageFootnote(text: l10n.usageVsQuotaNote),
        const SizedBox(height: 4),
        Align(
          alignment: Alignment.centerRight,
          child: TextButton(
            key: const Key('settings-usage-open-report'),
            onPressed: () => context.push(usageReportRoute),
            style: TextButton.styleFrom(foregroundColor: tokens.accent),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(l10n.usageOpenReport),
                const Icon(Icons.chevron_right, size: 18),
              ],
            ),
          ),
        ),
      ],
    );
  }
}

class _CardPeriodSwitcher extends StatelessWidget {
  const _CardPeriodSwitcher({required this.period, required this.onChanged});

  final UsagePeriod period;
  final ValueChanged<UsagePeriod> onChanged;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Align(
      alignment: Alignment.centerLeft,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        // The same control the report page uses. One period-picking pattern for
        // the whole feature, rather than a dropdown here and segments there.
        child: SegmentedButton<UsagePeriod>(
          key: const Key('settings-usage-period'),
          showSelectedIcon: false,
          segments: [
            for (final value in UsagePeriod.todayCard)
              ButtonSegment(
                value: value,
                label: Text(usageCardPeriodLabel(l10n, value)),
              ),
          ],
          selected: {period},
          onSelectionChanged: (selection) => onChanged(selection.first),
        ),
      ),
    );
  }
}

class _CardBody extends StatelessWidget {
  const _CardBody({
    required this.period,
    required this.response,
    required this.compact,
  });

  final UsagePeriod period;
  final UsageReportResponse? response;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final report = response?.report;

    // The same notice the quota panel shows, and never a zero.
    if (report == null || !report.range.recognized) {
      return InlineNotice(
        icon: Icons.cloud_off_outlined,
        text: l10n.usageUnavailable,
      );
    }
    if (report.isEmpty) {
      return InlineNotice(
        icon: Icons.inbox_outlined,
        text: l10n.usageEmptyPeriod(
          usageCardPeriodLabel(l10n, period).toLowerCase(),
        ),
      );
    }

    final locale = Localizations.localeOf(context).toLanguageTag();
    final totals = report.totals;
    // An empty detail line is not the same as no detail line: joining the two
    // optional parts unconditionally would render a stray separator.
    final tokenDetail = [
      usageDeltaText(l10n, period, report, locale),
      usageTokenBreakdownText(l10n, totals, locale),
    ].whereType<String>().join(' · ');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        UsageFigureRow(
          label: l10n.usageTokensLabel,
          value: formatCompactCount(totals.tokens, locale: locale),
          detail: tokenDetail.isEmpty ? null : tokenDetail,
        ),
        UsageFigureRow(
          label: l10n.usageCostLabel,
          value: l10n.usageCostQualified(
            formatUsageCost(totals.cost, locale: locale, compact: true),
          ),
        ),
        UsageFigureRow(
          label: l10n.usageRequestsLabel,
          value: formatCompactCount(totals.requests, locale: locale),
        ),
        if (report.activeTime?.activeMsSum != null)
          UsageFigureRow(
            label: l10n.usageAgentTimeLabel,
            value: l10n.usageHoursValue(
              formatUsageHours(report.activeTime!.activeMsSum!, locale: locale),
            ),
            tooltip: usageEstimatedTip(l10n, report.activeTime!),
          ),
        if (report.topModelsByTokens.isNotEmpty)
          UsageFigureRow(
            label: l10n.usageTopModelLabel,
            value: report.topModelsByTokens.first.name,
            detail: totals.tokens > 0
                ? l10n.usageShareOfTokens(
                    formatUsageShare(
                      report.topModelsByTokens.first.tokens / totals.tokens,
                      locale: locale,
                    ),
                  )
                : null,
          ),
        const SizedBox(height: 12),
        _Rankings(report: report, locale: locale, compact: compact),
      ],
    );
  }
}

/// The period-over-period change, phrased for the window it compares.
///
/// Returns `null` rather than a zero when the broker served no comparison: a
/// window with nothing to compare against has no delta, which is not the same
/// as a delta of nothing.
String? usageDeltaText(
  AppLocalizations l10n,
  UsagePeriod period,
  UsageReport report,
  String locale,
) {
  final percent = report.comparison?.tokensPct;
  if (percent == null) return null;
  final delta = formatUsageDelta(percent, locale: locale);
  return switch (period) {
    UsagePeriod.today => l10n.usageDeltaYesterday(delta),
    UsagePeriod.week || UsagePeriod.month => l10n.usageDeltaPriorDays(
      delta,
      report.range.days ?? 0,
    ),
    _ => l10n.usageDeltaPreviousPeriod(delta),
  };
}

class _Rankings extends StatelessWidget {
  const _Rankings({
    required this.report,
    required this.locale,
    required this.compact,
  });

  final UsageReport report;
  final String locale;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final total = report.totals.tokens;
    if (total <= 0) return const SizedBox.shrink();

    final harnesses = _RankingList(
      title: l10n.usageRankHarnesses,
      rows: [
        for (final tool in report.tools.take(5))
          (
            name: tool.label ?? tool.tool,
            tokens: tool.tokens,
            share: tool.tokens / total,
          ),
      ],
      locale: locale,
    );
    final models = _RankingList(
      title: l10n.usageRankModels,
      rows: [
        for (final model in report.topModelsByTokens.take(5))
          (
            name: model.name,
            tokens: model.tokens,
            share: model.tokens / total,
          ),
      ],
      locale: locale,
    );

    if (compact) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [harnesses, const SizedBox(height: 12), models],
      );
    }
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(child: harnesses),
        const SizedBox(width: 16),
        Expanded(child: models),
      ],
    );
  }
}

typedef _RankingRow = ({String name, double tokens, double share});

class _RankingList extends StatelessWidget {
  const _RankingList({
    required this.title,
    required this.rows,
    required this.locale,
  });

  final String title;
  final List<_RankingRow> rows;
  final String locale;

  @override
  Widget build(BuildContext context) {
    if (rows.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final tokens = context.tokens;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        UsageSectionTitle(title: title),
        for (final row in rows)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        row.name,
                        overflow: TextOverflow.ellipsis,
                        style: theme.textTheme.bodySmall,
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      formatUsageCountWithShare(
                        row.tokens,
                        row.share,
                        locale: locale,
                      ),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: tokens.textTertiary,
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 4),
                UsageShareBar(fraction: row.share, height: 4),
              ],
            ),
          ),
      ],
    );
  }
}
