import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_format.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_period.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_agent_logo.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_figures.dart';
import 'package:flutter/material.dart';

/// The period's leaders: harness, model, project — three rows each.
///
/// The project tile is the one that needs care. Its share is a share of the
/// *project facet*, and the facet cannot see every source — so the tile always
/// carries the reconciliation against the period total: named projects, the
/// facet's own unattributed bucket, and the remainder from sources that keep
/// no project records. Without that line a 39% leader reads as "39% of my
/// work", which is not what the number means.
///
/// Each tile lists its top three in the export card's row idiom — mark, name
/// left, figure right, a bar read against the leader — because the podium is
/// where the reader decides whether the period looks like what they remember,
/// and one name per facet answers only the easy half of that.
class UsagePodium extends StatelessWidget {
  /// Creates the podium.
  const UsagePodium({
    required this.period,
    required this.report,
    required this.locale,
    super.key,
  });

  /// Period being reported, which names the section.
  final UsagePeriod period;

  /// The served report.
  final UsageReport report;

  /// BCP-47 tag for figure formatting.
  final String locale;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final total = report.totals.tokens;
    if (total <= 0) return const SizedBox.shrink();

    final harnesses = report.tools.take(3).toList();
    final models = report.topModelsByTokens.take(3).toList();
    final projects = report.projects;
    final projectRows = projects == null
        ? const <UsageReportProjectRow>[]
        : projects.rows.take(3).toList();
    if (harnesses.isEmpty &&
        models.isEmpty &&
        projectRows.isEmpty &&
        !report.projectsWithheld) {
      return const SizedBox.shrink();
    }

    final reconciliation = UsageProjectReconciliation.of(projects, total);
    final tiles = <Widget>[
      if (harnesses.isNotEmpty)
        _PodiumTile(
          label: l10n.usagePodiumHarness,
          rows: [
            for (final tool in harnesses)
              (
                name: tool.label ?? tool.tool,
                tool: tool.tool,
                tokens: tool.tokens,
                share: tool.tokens / total,
              ),
          ],
          detail: _harnessDetail(l10n, harnesses.first, locale),
          locale: locale,
        ),
      if (models.isNotEmpty)
        _PodiumTile(
          label: l10n.usageTopModelLabel,
          rows: [
            for (final model in models)
              (
                name: model.name,
                tool: null,
                tokens: model.tokens,
                share: model.tokens / total,
              ),
          ],
          detail: l10n.usageCostQualified(
            formatUsageCost(models.first.cost, locale: locale, compact: true),
          ),
          locale: locale,
        ),
      if (projectRows.isNotEmpty)
        _PodiumTile(
          label: l10n.usagePodiumProject,
          rows: [
            for (final project in projectRows)
              (
                name: project.project,
                tool: null,
                tokens: project.tokens,
                // Against the period total, not against the facet's own sum:
                // the facet is a subset, and a share of a subset would
                // overstate it.
                share: project.tokens / total,
              ),
          ],
          locale: locale,
        ),
    ];

    return Column(
      key: const Key('usage-report-podium'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        UsageSectionTitle(title: _title(l10n, period)),
        LayoutBuilder(
          builder: (context, constraints) {
            if (constraints.maxWidth < 600) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (final tile in tiles)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: tile,
                    ),
                ],
              );
            }
            return IntrinsicHeight(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  for (var index = 0; index < tiles.length; index++) ...[
                    if (index > 0) const SizedBox(width: 12),
                    Expanded(child: tiles[index]),
                  ],
                ],
              ),
            );
          },
        ),
        if (projects != null &&
            projectRows.isNotEmpty &&
            reconciliation != null) ...[
          const SizedBox(height: 8),
          UsageFootnote(
            text: l10n.usagePodiumProjectNote(
              formatCompactCount(
                (projects.attributedCount ?? projects.rows.length).toDouble(),
                locale: locale,
              ),
              formatUsageShare(
                reconciliation.unattributedShare,
                locale: locale,
              ),
              formatUsageShare(reconciliation.gapShare, locale: locale),
            ),
          ),
          const SizedBox(height: 4),
          // Fragmentation the reader can see in the list is better stated than
          // silently merged: merging two remotes would invent a total.
          UsageFootnote(text: l10n.usageProjectGroupNote),
        ],
        // Said, not silently omitted. A missing tile reads as "no projects",
        // which is a claim about the work rather than about this caller.
        if (report.projectsWithheld) ...[
          const SizedBox(height: 8),
          UsageFootnote(text: l10n.usageProjectsOwnerOnly),
        ],
      ],
    );
  }

  static String _title(AppLocalizations l10n, UsagePeriod period) {
    return switch (period) {
      // The report never offers `today`; the branch exists so adding a period
      // later is a compile error rather than a silently wrong heading.
      UsagePeriod.today || UsagePeriod.week => l10n.usagePodiumTitleWeek,
      UsagePeriod.month => l10n.usagePodiumTitleMonth,
      UsagePeriod.year => l10n.usagePodiumTitleYear,
      UsagePeriod.allTime => l10n.usagePodiumTitleAllTime,
    };
  }

  static String? _harnessDetail(
    AppLocalizations l10n,
    UsageReportTool tool,
    String locale,
  ) {
    final sessions = tool.sessions;
    final activeMs = tool.activeMs;
    if (sessions == null || activeMs == null) return null;
    return l10n.usagePodiumHarnessDetail(
      formatCompactCount(sessions, locale: locale),
      formatUsageAgentTime(activeMs, locale: locale),
    );
  }
}

/// One ranked entry on a podium tile.
typedef _PodiumEntry = ({
  String name,
  String? tool,
  double tokens,
  double share,
});

class _PodiumTile extends StatelessWidget {
  const _PodiumTile({
    required this.label,
    required this.rows,
    required this.locale,
    this.detail,
  });

  final String label;
  final List<_PodiumEntry> rows;
  final String locale;

  /// The leader's subline (sessions · agent time, cost qualifier); rows two
  /// and three stand without one.
  final String? detail;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokensTheme = context.tokens;
    final leader = rows.first.tokens;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: tokensTheme.surface,
        border: Border.all(color: tokensTheme.separator),
        borderRadius: BorderRadius.circular(tokensTheme.radiusLg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            label,
            style: theme.textTheme.labelSmall?.copyWith(
              color: tokensTheme.textSecondary,
            ),
          ),
          const SizedBox(height: 4),
          for (var index = 0; index < rows.length; index++) ...[
            if (index > 0) const SizedBox(height: 6),
            _PodiumRow(
              entry: rows[index],
              leader: leader <= 0 ? 1 : leader,
              first: index == 0,
              locale: locale,
            ),
          ],
          if (detail != null) ...[
            const SizedBox(height: 6),
            Text(
              detail!,
              style: theme.textTheme.bodySmall?.copyWith(
                color: tokensTheme.textTertiary,
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// One podium row in the export card's idiom: optional mark, the name left,
/// the figure right, and a bar read against the leader beneath.
class _PodiumRow extends StatelessWidget {
  const _PodiumRow({
    required this.entry,
    required this.leader,
    required this.first,
    required this.locale,
  });

  final _PodiumEntry entry;
  final double leader;
  final bool first;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final nameStyle = first
        // The leader keeps the tile's emphasis; the rest are plainer.
        ? theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600)
        : theme.textTheme.bodySmall?.copyWith(
            fontWeight: FontWeight.w600,
            color: tokens.textSecondary,
          );
    final valueStyle = theme.textTheme.bodySmall?.copyWith(
      color: first ? tokens.textSecondary : tokens.textTertiary,
      fontWeight: first ? FontWeight.w600 : FontWeight.w400,
      fontFeatures: const [FontFeature.tabularFigures()],
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            if (entry.tool != null) ...[
              UsageAgentNameMark(
                tool: entry.tool!,
                style: nameStyle ?? DefaultTextStyle.of(context).style,
              ),
              const SizedBox(
                width: usageAgentNameMarkOffset - usageAgentNameMarkSize,
              ),
            ],
            Expanded(
              child: Text(
                entry.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: nameStyle,
              ),
            ),
            const SizedBox(width: 8),
            Text(
              formatUsageCountWithShare(
                entry.tokens,
                entry.share,
                locale: locale,
              ),
              style: valueStyle,
            ),
          ],
        ),
        const SizedBox(height: 3),
        UsageShareBar(fraction: entry.tokens / leader, height: 3),
      ],
    );
  }
}
