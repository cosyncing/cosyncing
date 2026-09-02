import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_format.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_figures.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_heatmap.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

/// Which of the two cards this is.
///
/// The privacy boundary is *which button you pressed*, not a toggle state. One
/// card carries counts only; the other adds project names. There is no setting
/// that moves content across that line, so a sender never has to audit a
/// checkbox before posting the image.
enum UsageExportCardKind {
  /// Counts only. No project names, no prompt text. Safe to post.
  overview,

  /// Counts plus project names. Share deliberately.
  projectDetail;

  /// Whether this card carries project names.
  bool get carriesProjectNames => this == UsageExportCardKind.projectDetail;
}

/// The logical width of an export card. 3× of this is the exported PNG width.
const double usageExportCardWidth = 360;

/// The logical height of an export card.
const double usageExportCardHeight = 640;

/// A shareable summary of the period, rendered for capture.
///
/// The card prints its own content policy in the footer: a recipient can audit
/// what it contains by reading it. That is the whole privacy design — the
/// manifest is not decoration, it is the guarantee.
class UsageExportCard extends StatelessWidget {
  /// Creates an export card.
  const UsageExportCard({
    required this.kind,
    required this.report,
    required this.machineLabel,
    required this.locale,
    required this.includeCost,
    super.key,
  });

  /// Which card this is.
  final UsageExportCardKind kind;

  /// The served report for the card's window.
  final UsageReport report;

  /// A nickname for the machine. Never the hostname.
  final String machineLabel;

  /// BCP-47 tag for figure formatting.
  final String locale;

  /// Whether to print the cost figure. Off by default, and always qualified.
  final bool includeCost;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final theme = Theme.of(context);

    return SizedBox(
      width: usageExportCardWidth,
      height: usageExportCardHeight,
      child: ColoredBox(
        color: tokens.canvas,
        // The frame is fixed because the artifact is; the content is whatever
        // the period holds, and a machine with five long project names has a
        // taller card than this one. Scaling is the only outcome that is never
        // wrong: clipping drops a figure, and a scrollable region cannot be
        // captured at all. Ordinary periods render at 1:1.
        child: FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.topCenter,
          child: SizedBox(
            width: usageExportCardWidth,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 8),
              child: DefaultTextStyle(
                style: theme.textTheme.bodySmall!.copyWith(
                  color: tokens.textPrimary,
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    _TierLabel(kind: kind),
                    const SizedBox(height: 3),
                    _Header(
                      report: report,
                      machineLabel: machineLabel,
                      locale: locale,
                    ),
                    const SizedBox(height: 8),
                    _Hero(
                      report: report,
                      locale: locale,
                      includeCost: includeCost,
                    ),
                    const SizedBox(height: 8),
                    _Section(
                      title: l10n.usageActiveDaysTitle,
                      child: _MiniHeatmap(report: report),
                    ),
                    const SizedBox(height: 6),
                    _Stats(kind: kind, report: report, locale: locale),
                    const SizedBox(height: 6),
                    _Rankings(report: report, locale: locale),
                    if (kind.carriesProjectNames) ...[
                      const SizedBox(height: 6),
                      _Projects(report: report, locale: locale),
                    ],
                    const SizedBox(height: 6),
                    _Manifest(kind: kind),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _TierLabel extends StatelessWidget {
  const _TierLabel({required this.kind});

  final UsageExportCardKind kind;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final theme = Theme.of(context);
    return Row(
      children: [
        if (kind.carriesProjectNames) ...[
          // The amber role *is* the amber tier. The more private card looks
          // more private at thumbnail distance, not only on close reading.
          Icon(Icons.circle, size: 8, color: tokens.statusNeedsInput),
          const SizedBox(width: 6),
        ],
        Flexible(
          child: Text(
            kind.carriesProjectNames
                ? l10n.usageCardTierProjects
                : l10n.usageCardTierOverview,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.labelSmall?.copyWith(
              color: kind.carriesProjectNames
                  ? tokens.statusNeedsInput
                  : tokens.textSecondary,
              letterSpacing: 0.8,
            ),
          ),
        ),
      ],
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({
    required this.report,
    required this.machineLabel,
    required this.locale,
  });

  final UsageReport report;
  final String machineLabel;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final from = DateTime.tryParse(report.range.from);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          from == null
              ? l10n.usageHubTileTitle
              : l10n.usageCardPeriodYtd(DateFormat.y(locale).format(from)),
          style: theme.textTheme.titleSmall?.copyWith(
            fontWeight: FontWeight.w600,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
        const SizedBox(height: 1),
        Text(
          l10n.usageCardRange(
            report.range.from,
            report.range.to,
            machineLabel,
          ),
          style: theme.textTheme.labelSmall?.copyWith(
            color: tokens.textTertiary,
          ),
        ),
      ],
    );
  }
}

class _Hero extends StatelessWidget {
  const _Hero({
    required this.report,
    required this.locale,
    required this.includeCost,
  });

  final UsageReport report;
  final String locale;
  final bool includeCost;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final sessions = usageExportSessionCount(report);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          formatCompactCount(report.totals.tokens, locale: locale),
          style: theme.textTheme.headlineSmall?.copyWith(
            // The one place the accent is allowed to go big.
            color: tokens.accent,
            fontWeight: FontWeight.w700,
            fontFeatures: const [FontFeature.tabularFigures()],
          ),
        ),
        const SizedBox(height: 1),
        Text(
          l10n.usageCardHeroSub(
            sessions == null
                ? '—'
                : formatCompactCount(sessions, locale: locale),
            formatCompactCount(report.totals.requests, locale: locale),
          ),
          style: theme.textTheme.labelSmall?.copyWith(
            color: tokens.textSecondary,
          ),
        ),
        if (includeCost) ...[
          const SizedBox(height: 4),
          Text(
            // Never bare, even here: an image outlives the screen it was
            // captured from, and its reader has no tooltip to consult.
            l10n.usageCostQualified(
              formatUsageCost(
                report.totals.cost,
                locale: locale,
                compact: true,
              ),
            ),
            style: theme.textTheme.labelSmall?.copyWith(
              color: tokens.textTertiary,
            ),
          ),
        ],
      ],
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({
    required this.title,
    required this.child,
    this.amber = false,
  });

  final String title;
  final Widget child;
  final bool amber;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final body = Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          title,
          style: theme.textTheme.labelSmall?.copyWith(
            color: amber ? tokens.statusNeedsInput : tokens.textSecondary,
          ),
        ),
        const SizedBox(height: 3),
        child,
      ],
    );
    if (!amber) return body;
    return Container(
      padding: const EdgeInsets.only(left: 8),
      decoration: BoxDecoration(
        border: Border(
          left: BorderSide(color: tokens.statusNeedsInput, width: 3),
        ),
      ),
      child: body,
    );
  }
}

class _MiniHeatmap extends StatelessWidget {
  const _MiniHeatmap({required this.report});

  final UsageReport report;

  @override
  Widget build(BuildContext context) {
    final from = DateTime.tryParse(report.range.from);
    final to = DateTime.tryParse(report.range.to);
    final daily = report.daily;
    if (from == null || to == null || daily == null || daily.isEmpty) {
      return const SizedBox.shrink();
    }
    // The same widget the report page uses, at a smaller cell: one component,
    // two densities, one bucketing rule.
    return UsageHeatmap(
      from: from,
      to: to,
      intensityByDate: {
        for (final day in daily)
          if (day.intensity != null) day.date: day.intensity!,
      },
      cellSize: 5,
      gap: 1,
      showWeekdayLabels: false,
    );
  }
}

class _Stats extends StatelessWidget {
  const _Stats({
    required this.kind,
    required this.report,
    required this.locale,
  });

  final UsageExportCardKind kind;
  final UsageReport report;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final streaks = report.streaks;
    final firsts = report.firsts;
    final activeDays = streaks?.activeDays;
    final totalDays = streaks?.totalDays;
    final streak = streaks?.currentStreak;
    final busiest = firsts?.busiestDay;
    final busiestDate = busiest == null ? null : DateTime.tryParse(busiest);
    final busiestTokens = firsts?.busiestDayTokens;
    final activeMs = report.activeTime?.activeMsSum;

    final rows = <Widget>[
      if (activeDays != null && totalDays != null)
        _StatRow(
          label: l10n.usageCardDaysActive(
            formatCompactCount(activeDays, locale: locale),
            formatCompactCount(totalDays, locale: locale),
          ),
          value: streak == null || streak <= 0
              ? null
              : l10n.usageCardStreak(
                  formatCompactCount(streak, locale: locale),
                ),
        ),
      // The project card gives its space to the project list instead; these
      // two lines are the difference.
      if (!kind.carriesProjectNames) ...[
        if (busiestDate != null && busiestTokens != null)
          _StatRow(
            label: l10n.usageCardBusiest(
              DateFormat.MMMd(locale).format(busiestDate),
              formatCompactCount(busiestTokens, locale: locale),
            ),
            value: null,
          ),
        if (activeMs != null)
          _StatRow(
            label: l10n.usageCardActiveTime,
            value: l10n.usageHoursValue(
              formatUsageHours(activeMs, locale: locale),
            ),
          ),
      ],
    ];
    if (rows.isEmpty) return const SizedBox.shrink();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: rows,
    );
  }
}

class _StatRow extends StatelessWidget {
  const _StatRow({required this.label, required this.value});

  final String label;
  final String? value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.labelSmall?.copyWith(
                color: tokens.textSecondary,
              ),
            ),
          ),
          if (value != null)
            Text(
              value!,
              style: theme.textTheme.labelSmall?.copyWith(
                fontWeight: FontWeight.w600,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
        ],
      ),
    );
  }
}

class _Rankings extends StatelessWidget {
  const _Rankings({required this.report, required this.locale});

  final UsageReport report;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final total = report.totals.tokens;
    if (total <= 0) return const SizedBox.shrink();
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: _MiniList(
            title: l10n.usageRankHarnesses,
            rows: [
              for (final tool in report.tools.take(3))
                (
                  name: tool.label ?? tool.tool,
                  tokens: tool.tokens,
                  share: tool.tokens / total,
                ),
            ],
            locale: locale,
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: _MiniList(
            title: l10n.usageRankModels,
            rows: [
              for (final model in report.topModelsByTokens.take(3))
                (
                  name: model.name,
                  tokens: model.tokens,
                  share: model.tokens / total,
                ),
            ],
            locale: locale,
          ),
        ),
      ],
    );
  }
}

typedef _MiniRow = ({String name, double tokens, double share});

class _MiniList extends StatelessWidget {
  const _MiniList({
    required this.title,
    required this.rows,
    required this.locale,
  });

  final String title;
  final List<_MiniRow> rows;
  final String locale;

  @override
  Widget build(BuildContext context) {
    if (rows.isEmpty) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final tokens = context.tokens;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          title,
          style: theme.textTheme.labelSmall?.copyWith(
            color: tokens.textSecondary,
          ),
        ),
        const SizedBox(height: 3),
        for (var index = 0; index < rows.length; index++)
          Padding(
            padding: const EdgeInsets.only(bottom: 2),
            child: Row(
              children: [
                SizedBox(
                  width: 12,
                  child: Text(
                    formatUsageRank(index, locale: locale),
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: tokens.textTertiary,
                    ),
                  ),
                ),
                Expanded(
                  child: Text(
                    rows[index].name,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelSmall,
                  ),
                ),
                const SizedBox(width: 4),
                Text(
                  formatUsageCountWithShare(
                    rows[index].tokens,
                    rows[index].share,
                    locale: locale,
                  ),
                  style: theme.textTheme.labelSmall?.copyWith(
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

class _Projects extends StatelessWidget {
  const _Projects({required this.report, required this.locale});

  final UsageReport report;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final projects = report.projects;
    if (projects == null || projects.rows.isEmpty) {
      return const SizedBox.shrink();
    }
    final leader = projects.rows.first.tokens;
    final total = report.totals.tokens;
    final reconciliation = UsageProjectReconciliation.of(projects, total);
    final theme = Theme.of(context);
    final tokens = context.tokens;

    return _Section(
      amber: true,
      title: l10n.usageCardProjectsNote(
        formatCompactCount(
          (projects.attributedCount ?? projects.rows.length).toDouble(),
          locale: locale,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          for (var index = 0; index < projects.rows.take(5).length; index++)
            Padding(
              padding: const EdgeInsets.only(bottom: 2),
              child: Row(
                children: [
                  SizedBox(
                    width: 16,
                    child: Text(
                      formatUsageRankLabel(index, locale: locale),
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: tokens.textTertiary,
                      ),
                    ),
                  ),
                  Expanded(
                    child: Text(
                      projects.rows[index].project,
                      overflow: TextOverflow.ellipsis,
                      style: theme.textTheme.labelSmall?.copyWith(
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  SizedBox(
                    width: 40,
                    child: UsageShareBar(
                      // Against the leader, so the top row is a full bar and
                      // the rest are read against it rather than against a
                      // period total the facet cannot see all of.
                      fraction: leader <= 0
                          ? 0
                          : projects.rows[index].tokens / leader,
                      height: 3,
                    ),
                  ),
                  const SizedBox(width: 6),
                  Text(
                    formatUsageCountWithShare(
                      projects.rows[index].tokens,
                      total <= 0 ? 0 : projects.rows[index].tokens / total,
                      locale: locale,
                    ),
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: tokens.textTertiary,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                ],
              ),
            ),
          if (reconciliation != null)
            Text(
              l10n.usageCardGroupNote(
                formatUsageShare(
                  reconciliation.unattributedShare,
                  locale: locale,
                ),
                formatUsageShare(reconciliation.gapShare, locale: locale),
              ),
              style: theme.textTheme.labelSmall?.copyWith(
                color: tokens.textTertiary,
              ),
            ),
        ],
      ),
    );
  }
}

class _Manifest extends StatelessWidget {
  const _Manifest({required this.kind});

  final UsageExportCardKind kind;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(height: 1, color: tokens.separator),
        const SizedBox(height: 3),
        // The card audits itself. A recipient reads what it contains; the
        // sender never has to reason about a toggle they set weeks ago.
        Text(
          kind.carriesProjectNames
              ? l10n.usageCardManifestProjects
              : l10n.usageCardManifestOverview,
          style: theme.textTheme.labelSmall?.copyWith(
            color: tokens.textSecondary,
          ),
        ),
        Text(
          l10n.usageCardAttribution,
          style: theme.textTheme.labelSmall?.copyWith(
            color: tokens.textTertiary,
          ),
        ),
      ],
    );
  }
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
