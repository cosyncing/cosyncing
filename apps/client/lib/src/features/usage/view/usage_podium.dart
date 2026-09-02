import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_format.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_period.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_figures.dart';
import 'package:flutter/material.dart';

/// The three leaders of the period: harness, model, project.
///
/// The project tile is the one that needs care. Its share is a share of the
/// *project facet*, and the facet cannot see every source — so the tile always
/// carries the reconciliation against the period total: named projects, the
/// facet's own unattributed bucket, and the remainder from sources that keep no
/// project records. Without that line a 39% leader reads as "39% of my work",
/// which is not what the number means.
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

    final harness = report.tools.isEmpty ? null : report.tools.first;
    final model = report.topModelsByTokens.isEmpty
        ? null
        : report.topModelsByTokens.first;
    final projects = report.projects;
    final project = (projects == null || projects.rows.isEmpty)
        ? null
        : projects.rows.first;
    if (harness == null &&
        model == null &&
        project == null &&
        !report.projectsWithheld) {
      return const SizedBox.shrink();
    }

    final reconciliation = UsageProjectReconciliation.of(projects, total);
    final tiles = <Widget>[
      if (harness != null)
        _PodiumTile(
          label: l10n.usagePodiumHarness,
          name: harness.label ?? harness.tool,
          share: harness.tokens / total,
          tokens: harness.tokens,
          detail: _harnessDetail(l10n, harness, locale),
          locale: locale,
        ),
      if (model != null)
        _PodiumTile(
          label: l10n.usageTopModelLabel,
          name: model.name,
          share: model.tokens / total,
          tokens: model.tokens,
          detail: l10n.usageCostQualified(
            formatUsageCost(model.cost, locale: locale, compact: true),
          ),
          locale: locale,
        ),
      if (project != null)
        _PodiumTile(
          label: l10n.usagePodiumProject,
          name: project.project,
          // Against the period total, not against the facet's own sum: the
          // facet is a subset, and a share of a subset would overstate it.
          share: project.tokens / total,
          tokens: project.tokens,
          detail: null,
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
        if (projects != null && project != null && reconciliation != null) ...[
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
      l10n.usageHoursValue(formatUsageHours(activeMs, locale: locale)),
    );
  }
}

class _PodiumTile extends StatelessWidget {
  const _PodiumTile({
    required this.label,
    required this.name,
    required this.share,
    required this.tokens,
    required this.detail,
    required this.locale,
  });

  final String label;
  final String name;
  final double share;
  final double tokens;
  final String? detail;
  final String locale;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokensTheme = context.tokens;
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
          Text(
            name,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            // Content, not chrome: the toolbar type ceiling does not apply.
            style: theme.textTheme.titleSmall?.copyWith(
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            formatUsageCountWithShare(tokens, share, locale: locale),
            style: theme.textTheme.bodySmall?.copyWith(
              color: tokensTheme.textSecondary,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(height: 6),
          UsageShareBar(fraction: share),
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
