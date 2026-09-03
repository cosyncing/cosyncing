import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_format.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_period.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

/// Three numbers and one sentence.
///
/// The numbers stay plain and the sentence carries the voice — and the sentence
/// is one parameterized string, not a story assembled from clauses. Every part
/// of it is a served figure; if the broker served no comparison the sentence
/// loses its final clause rather than gaining a zero.
class UsageHero extends StatelessWidget {
  /// Creates the hero.
  const UsageHero({
    required this.period,
    required this.report,
    required this.periodLabel,
    required this.locale,
    this.activeTimeTooltip,
    super.key,
  });

  /// Period being reported.
  final UsagePeriod period;

  /// The served report.
  final UsageReport report;

  /// The window's own name, e.g. `August 2026`.
  final String periodLabel;

  /// How the agent-time estimate is made. Computed by the page from the served
  /// idle-gap cap, so this widget does not carry a second copy of that rule.
  final String? activeTimeTooltip;

  /// BCP-47 tag for figure formatting.
  final String locale;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final activeMs = report.activeTime?.activeMsSum;
    final activeDays = report.streaks?.activeDays;

    final cells = <Widget>[
      _HeroCell(
        value: formatCompactCount(report.totals.tokens, locale: locale),
        unit: l10n.usageHeroTokens,
      ),
      if (activeMs != null)
        _HeroCell(
          value: l10n.usageHoursValue(
            formatUsageHours(activeMs, locale: locale),
          ),
          unit: l10n.usageHeroActiveTime,
          pill: l10n.usageEstimatedShort,
          tooltip: activeTimeTooltip,
        ),
      if (activeDays != null)
        _HeroCell(
          value: formatCompactCount(activeDays, locale: locale),
          unit: l10n.usageHeroActiveDays,
        ),
    ];

    final sentence = usageHeroSentence(
      l10n,
      period: period,
      report: report,
      periodLabel: periodLabel,
      locale: locale,
    );

    return Column(
      key: const Key('usage-report-hero'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // The three cells share a height whatever their content, and the page
        // scrolls, so the row has no height to stretch into on its own.
        IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              for (var index = 0; index < cells.length; index++) ...[
                if (index > 0) const SizedBox(width: 8),
                Expanded(child: cells[index]),
              ],
            ],
          ),
        ),
        const SizedBox(height: 12),
        Text(
          sentence,
          key: const Key('usage-report-hero-sentence'),
          style: Theme.of(context).textTheme.bodyMedium,
        ),
      ],
    );
  }
}

class _HeroCell extends StatelessWidget {
  const _HeroCell({
    required this.value,
    required this.unit,
    this.pill,
    this.tooltip,
  });

  final String value;
  final String unit;
  final String? pill;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final cell = Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
      decoration: BoxDecoration(
        color: tokens.surface,
        border: Border.all(color: tokens.separator),
        borderRadius: BorderRadius.circular(tokens.radiusLg),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: Alignment.centerLeft,
            child: Text(
              value,
              style: theme.textTheme.headlineSmall?.copyWith(
                fontWeight: FontWeight.w600,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
          ),
          const SizedBox(height: 4),
          Row(
            children: [
              Flexible(
                child: Text(
                  unit,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: tokens.textTertiary,
                  ),
                ),
              ),
              if (pill != null) ...[
                const SizedBox(width: 6),
                StatusPill(label: pill!, color: tokens.statusIdle),
              ],
            ],
          ),
        ],
      ),
    );
    return tooltip == null ? cell : Tooltip(message: tooltip, child: cell);
  }
}

/// The report's one sentence.
///
/// Falls back to the comparison-free form whenever the broker served no
/// `tokens_pct` or the period has no nameable predecessor — a report cannot
/// say "more than last month" when it does not know what last month was.
String usageHeroSentence(
  AppLocalizations l10n, {
  required UsagePeriod period,
  required UsageReport report,
  required String periodLabel,
  required String locale,
}) {
  final sessions = usageSessionCount(report);
  final sessionsText = sessions == null
      ? _emDash
      : formatUsageCount(sessions, locale: locale);
  final tokensText = formatCompactCount(report.totals.tokens, locale: locale);
  final costText = l10n.usageCostQualified(
    formatUsageCost(report.totals.cost, locale: locale, compact: true),
  );

  final percent = report.comparison?.tokensPct;
  final previous = usagePreviousPeriodLabel(period, report.range, locale);
  if (percent == null ||
      previous == null ||
      !usageComparisonIsMeaningful(report)) {
    return l10n.usageHeroSentencePlain(
      periodLabel,
      sessionsText,
      tokensText,
      costText,
    );
  }
  final magnitude = formatUsagePercent(percent, locale: locale);
  final delta = percent < 0
      ? l10n.usageDeltaLess(magnitude)
      : l10n.usageDeltaMore(magnitude);
  return l10n.usageHeroSentence(
    periodLabel,
    sessionsText,
    tokensText,
    costText,
    delta,
    previous,
  );
}

const String _emDash = '—';

/// Above this ratio the prior window is not a quieter period, it is a period
/// before the record began, and a percentage stops carrying meaning.
///
/// A hundredfold is a stated judgement, not a measurement — but the
/// alternative is quoting the served figure, and on this machine's real 2026
/// year window that figure is 1,231,088%: arithmetically true and about
/// nothing. Tokdash's `firsts` facet cannot settle it either way, because it
/// is scoped to the queried window and so reports the first active day
/// *inside* it, never the first the record holds.
const double _comparisonMeaningfulRatio = 100;

/// Whether the served comparison says something a percentage can carry.
///
/// The broker serves a comparison for every window, including the first one a
/// machine ever recorded. When the prior stretch holds nothing, or nearly
/// nothing, the sentence drops its final clause rather than quoting a figure
/// in the hundreds of thousands of percent.
bool usageComparisonIsMeaningful(UsageReport report) {
  final previous = report.comparison?.tokensPrev;
  if (previous == null) return true;
  if (previous <= 0) return false;
  return report.totals.tokens <= previous * _comparisonMeaningfulRatio;
}

/// Sessions in the period, from the active-time API or the per-tool rows.
///
/// Returns `null` rather than zero when neither source served a count.
int? usageSessionCount(UsageReport report) {
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

/// The name of the window this period is being compared against.
///
/// Only the periods whose predecessor has a name get one. A week has no common
/// name, and all time has no predecessor at all, so both drop the clause rather
/// than inventing a phrase for it.
String? usagePreviousPeriodLabel(
  UsagePeriod period,
  UsageReportRange range,
  String locale,
) {
  final from = DateTime.tryParse(range.from);
  if (from == null) return null;
  return switch (period) {
    UsagePeriod.month => DateFormat.MMMM(
      locale,
    ).format(DateTime.utc(from.year, from.month - 1)),
    UsagePeriod.year => DateFormat.y(
      locale,
    ).format(DateTime.utc(from.year - 1)),
    _ => null,
  };
}
