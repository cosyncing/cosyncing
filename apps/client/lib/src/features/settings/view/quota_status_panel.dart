import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:flutter/material.dart';

/// Remaining-percent threshold at or under which a quota row reads as a
/// warning. Matches the broker's quota-warning evaluator
/// (`packages/typescript/broker/src/installation/tokdash-quota.ts`).
const double quotaWarningRemainingPercent = 25;

/// Remaining-percent threshold at or under which a quota row reads as
/// critical — a presentation-only escalation of the same warning signal.
const double quotaCriticalRemainingPercent = 10;

/// Tokdash-style quota status bars for Settings → Agents & usage.
///
/// Renders the normalized [TokdashQuotaResponse] already held by
/// `ManagedRuntimeController` as provider/window rows: 5-hour and weekly
/// labels, percentage remaining, a compact progress bar, reset time,
/// freshness, and estimated/stale/unavailable status. Antigravity's per-model
/// readings collapse into its two shared quota pools, matching Tokdash's own
/// quota page. Viewing is independent of the quota-warnings opt-in, and the
/// panel never shows raw payloads, endpoints, bucket ids, or API errors.
class QuotaStatusPanel extends StatelessWidget {
  /// Creates a quota panel.
  ///
  /// [quota] is the latest broker-proxied snapshot; `null` means the read
  /// failed. [now] is injectable for deterministic tests.
  const QuotaStatusPanel({
    this.quota,
    this.loading = false,
    this.now,
    super.key,
  });

  /// Latest quota snapshot, or `null` when the read failed.
  final TokdashQuotaResponse? quota;

  /// Whether the first snapshot is still being read.
  final bool loading;

  /// Reference clock for relative reset/freshness copy.
  final DateTime? now;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final now = this.now ?? DateTime.now();

    return SelectionArea(
      child: Column(
        key: const Key('settings-quota-panel'),
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            l10n.settingsQuotaPanelTitle,
            style: theme.textTheme.labelLarge?.copyWith(
              color: tokens.textSecondary,
            ),
          ),
          const SizedBox(height: 8),
          if (loading)
            _QuotaNotice(
              icon: null,
              text: l10n.settingsQuotaLoading,
              showSpinner: true,
            )
          else
            _buildContent(context, l10n, now),
          const SizedBox(height: 8),
          Text(
            l10n.settingsQuotaReadOnlyNote,
            style: theme.textTheme.bodySmall?.copyWith(
              color: tokens.textTertiary,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildContent(
    BuildContext context,
    AppLocalizations l10n,
    DateTime now,
  ) {
    final quota = this.quota;
    final data = quota?.data;
    if (quota == null || quota.ok == false || data == null) {
      return _QuotaNotice(
        icon: Icons.cloud_off_outlined,
        text: l10n.settingsQuotaUnavailable,
      );
    }
    if (!data.enabled) {
      return _QuotaNotice(
        icon: Icons.toggle_off_outlined,
        text: l10n.settingsQuotaMonitoringOff,
      );
    }

    final groups = <Widget>[];
    final providerIds = data.providers.keys.toList()..sort();
    for (final providerId in providerIds) {
      final provider = data.providers[providerId]!;
      // Tokdash always ships a shell per provider; a genuine unconfigured
      // shell (status "unavailable", no buckets, no failure detail) is not
      // stale — skip it. Any other empty provider records a real failure
      // (e.g. fetch_error with no detail) and must stay visible.
      final hasFailureDetail = provider.statusDetail?.isNotEmpty ?? false;
      final isUnconfiguredShell =
          provider.buckets.isEmpty &&
          provider.status == 'unavailable' &&
          !hasFailureDetail;
      if (isUnconfiguredShell) continue;
      groups.add(
        _QuotaProviderGroup(
          providerId: providerId,
          provider: provider,
          now: now,
        ),
      );
    }
    if (groups.isEmpty) {
      return _QuotaNotice(
        icon: Icons.cloud_off_outlined,
        text: l10n.settingsQuotaUnavailable,
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var index = 0; index < groups.length; index++) ...[
          if (index > 0) const SizedBox(height: 16),
          groups[index],
        ],
      ],
    );
  }
}

/// One provider's quota rows: a header with freshness and status pills, then
/// its display-level bucket groups. Most providers retain generic window
/// ordering; Antigravity mirrors Tokdash's two shared model pools instead of
/// repeating one row per model.
class _QuotaProviderGroup extends StatelessWidget {
  const _QuotaProviderGroup({
    required this.providerId,
    required this.provider,
    required this.now,
  });

  final String providerId;
  final TokdashQuotaProvider provider;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final failed =
        provider.status != 'ok' || (provider.statusDetail?.isNotEmpty ?? false);
    final providerName = quotaProviderDisplayName(provider.provider);
    final freshness = _freshnessCopy(l10n, now);

    final buckets = _quotaBucketsForPresentation(
      providerId,
      provider.buckets,
      l10n,
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                providerName,
                style: theme.textTheme.labelLarge,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            if (provider.estimated) ...[
              StatusPill(
                label: l10n.settingsQuotaEstimated,
                color: tokens.statusIdle,
              ),
              const SizedBox(width: 8),
            ],
            if (failed)
              StatusPill(
                label: l10n.settingsQuotaStale,
                color: tokens.statusNeedsInput,
              ),
          ],
        ),
        if (freshness != null) ...[
          const SizedBox(height: 4),
          Text(
            freshness,
            style: theme.textTheme.bodySmall?.copyWith(
              color: tokens.textTertiary,
            ),
          ),
        ],
        const SizedBox(height: 8),
        if (buckets.isEmpty)
          Text(
            l10n.settingsQuotaNoReadings,
            style: theme.textTheme.bodySmall?.copyWith(
              color: tokens.textTertiary,
            ),
          )
        else
          for (var index = 0; index < buckets.length; index++) ...[
            if (index > 0) const SizedBox(height: 12),
            if (buckets[index].groupLabel case final groupLabel?) ...[
              Text(
                groupLabel,
                style: theme.textTheme.labelMedium?.copyWith(
                  color: tokens.textSecondary,
                  fontWeight: FontWeight.w600,
                ),
              ),
              const SizedBox(height: 8),
            ],
            _QuotaBucketRow(
              providerName: providerName,
              providerId: providerId,
              bucket: buckets[index].bucket,
              bucketKey: buckets[index].key,
              groupLabel: buckets[index].groupLabel,
              windowLabelOverride: buckets[index].windowLabel,
              estimated: provider.estimated,
              // A non-ok bucket status means the row shows a last-known
              // reading even while the provider as a whole is healthy.
              stale: failed || buckets[index].bucket.status != 'ok',
              // The provider header already carries the Stale pill when the
              // whole provider failed; only flag bucket-level failures inline.
              showStalePill: !failed && buckets[index].bucket.status != 'ok',
              now: now,
            ),
          ],
      ],
    );
  }

  /// Freshness is computed client-side from the newest reading stamp
  /// (provider `updated_at` or the newest bucket `captured_at`), already
  /// normalized to epoch milliseconds by the contract model.
  String? _freshnessCopy(AppLocalizations l10n, DateTime now) {
    final stamps = <num>[
      if (provider.updatedAt != null) provider.updatedAt!,
      for (final bucket in provider.buckets) bucket.capturedAt,
    ].where((stamp) => stamp > 0);
    if (stamps.isEmpty) return null;
    final newest = stamps.reduce((a, b) => a > b ? a : b);
    final captured = DateTime.fromMillisecondsSinceEpoch(newest.toInt());
    return quotaUpdatedCopy(l10n, now, captured);
  }
}

/// One display-level quota row. [groupLabel] and [windowLabel] are present for
/// Antigravity's shared model pools; the underlying contract bucket is kept
/// unchanged.
class _QuotaBucketPresentation {
  const _QuotaBucketPresentation({
    required this.bucket,
    required this.key,
    this.groupLabel,
    this.windowLabel,
  });

  final TokdashQuotaBucket bucket;
  final String key;
  final String? groupLabel;
  final String? windowLabel;
}

class _AntigravityPool {
  const _AntigravityPool({
    required this.key,
    required this.label,
    required this.matches,
  });

  final String key;
  final String label;
  final bool Function(String modelName) matches;
}

/// Applies Tokdash's display-only Antigravity pooling rule: Gemini models
/// share one quota pool, while Claude/GPT/OSS models share the other. The API
/// reports the shared five-hour limit once per model, so each pool uses the
/// lowest remaining member reading and drops the redundant model rows.
List<_QuotaBucketPresentation> _quotaBucketsForPresentation(
  String providerId,
  List<TokdashQuotaBucket> source,
  AppLocalizations l10n,
) {
  if (providerId.toLowerCase() != 'antigravity') {
    final buckets = [...source]
      ..sort((a, b) {
        final kindOrder = _quotaWindowKind(
          a.bucket,
        ).index.compareTo(_quotaWindowKind(b.bucket).index);
        if (kindOrder != 0) return kindOrder;
        // Pooled windows above model-scoped ones within each kind, so the
        // shared limit always leads its group.
        final scopedOrder =
            (_scopedWindowLabel(providerId, a, l10n) == null ? 0 : 1).compareTo(
              _scopedWindowLabel(providerId, b, l10n) == null ? 0 : 1,
            );
        if (scopedOrder != 0) return scopedOrder;
        return a.bucketLabel.compareTo(b.bucketLabel);
      });
    return [
      for (final bucket in buckets)
        _QuotaBucketPresentation(
          bucket: bucket,
          key: bucket.bucket,
          windowLabel: _scopedWindowLabel(providerId, bucket, l10n),
        ),
    ];
  }

  final pools = [
    _AntigravityPool(
      key: 'gemini',
      label: l10n.settingsQuotaAntigravityGeminiModels,
      matches: (name) => name.contains('gemini'),
    ),
    _AntigravityPool(
      key: 'claude-gpt',
      label: l10n.settingsQuotaAntigravityClaudeGptModels,
      matches: (name) =>
          name.contains('claude') ||
          name.contains('gpt') ||
          name.contains('oss'),
    ),
  ];

  final result = <_QuotaBucketPresentation>[];
  for (final pool in pools) {
    TokdashQuotaBucket? lowest;
    for (final bucket in source) {
      final modelName =
          (bucket.bucketLabel.isNotEmpty ? bucket.bucketLabel : bucket.bucket)
              .toLowerCase();
      final remaining = bucket.remainingPercent;
      if (!pool.matches(modelName) || remaining == null) continue;
      if (lowest == null || remaining < lowest.remainingPercent!) {
        lowest = bucket;
      }
    }
    if (lowest == null) continue;
    result.add(
      _QuotaBucketPresentation(
        bucket: lowest,
        key: 'pool-${pool.key}',
        groupLabel: pool.label,
        windowLabel: l10n.settingsQuotaWindowFiveHour,
      ),
    );
  }
  return result;
}

/// One window row: label, percentage remaining, compact bar, and reset time.
class _QuotaBucketRow extends StatelessWidget {
  const _QuotaBucketRow({
    required this.providerName,
    required this.providerId,
    required this.bucket,
    required this.bucketKey,
    required this.estimated,
    required this.stale,
    required this.showStalePill,
    required this.now,
    this.groupLabel,
    this.windowLabelOverride,
  });

  final String providerName;
  final String providerId;
  final TokdashQuotaBucket bucket;
  final String bucketKey;
  final bool estimated;
  final bool stale;
  final bool showStalePill;
  final DateTime now;
  final String? groupLabel;
  final String? windowLabelOverride;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final remaining = bucket.remainingPercent;
    final windowLabel = windowLabelOverride ?? _windowLabel(l10n);
    final severityColor = remaining == null
        ? tokens.textTertiary
        : quotaSeverityColor(tokens, remaining);
    final resetCopy = _resetCopy(l10n, now);

    final semanticsParts = <String>[
      [providerName, groupLabel, windowLabel].whereType<String>().join(' '),
      if (remaining != null)
        l10n.settingsQuotaPercentRemaining('${remaining.round()}')
      else
        l10n.settingsQuotaNoReadings,
      if (resetCopy != null) resetCopy,
      if (estimated) l10n.settingsQuotaEstimated,
      if (stale) l10n.settingsQuotaStale,
    ];

    return Semantics(
      key: Key('settings-quota-row-$providerId-$bucketKey'),
      container: true,
      label: semanticsParts.join(', '),
      child: ExcludeSemantics(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    windowLabel,
                    style: theme.textTheme.bodyMedium,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                if (showStalePill) ...[
                  StatusPill(
                    label: l10n.settingsQuotaStale,
                    color: tokens.statusNeedsInput,
                  ),
                  const SizedBox(width: 8),
                ],
                if (remaining != null)
                  Text(
                    l10n.settingsQuotaPercentCompact('${remaining.round()}'),
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: severityColor,
                      fontWeight: FontWeight.w600,
                    ),
                  )
                else
                  Text(
                    l10n.settingsQuotaNoReadings,
                    style: theme.textTheme.labelMedium?.copyWith(
                      color: tokens.textTertiary,
                    ),
                  ),
              ],
            ),
            if (remaining != null) ...[
              const SizedBox(height: 4),
              LinearProgressIndicator(
                value: (remaining.clamp(0, 100)) / 100,
                minHeight: 8,
                borderRadius: BorderRadius.circular(tokens.radiusXs),
                color: severityColor,
                backgroundColor: tokens.surface2,
              ),
            ],
            if (resetCopy != null) ...[
              const SizedBox(height: 4),
              Text(
                resetCopy,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: tokens.textTertiary,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  String _windowLabel(AppLocalizations l10n) {
    switch (_quotaWindowKind(bucket.bucket)) {
      case _QuotaWindowKind.fiveHour:
        return l10n.settingsQuotaWindowFiveHour;
      case _QuotaWindowKind.weekly:
        return l10n.settingsQuotaWindowWeekly;
      case _QuotaWindowKind.other:
        // Server-provided human label for metered/unknown/future windows.
        return bucket.bucketLabel.isNotEmpty
            ? bucket.bucketLabel
            : l10n.settingsQuotaWindowGeneric;
    }
  }

  String? _resetCopy(AppLocalizations l10n, DateTime now) {
    final resetsAt = bucket.resetsAt;
    if (resetsAt == null || resetsAt <= 0) return null;
    // Normalized to epoch milliseconds by the contract model.
    final reset = DateTime.fromMillisecondsSinceEpoch(resetsAt.toInt());
    return quotaResetCopy(l10n, now, reset);
  }
}

/// Neutral notice row for loading, unavailable, and monitoring-off states.
class _QuotaNotice extends StatelessWidget {
  const _QuotaNotice({
    required this.icon,
    required this.text,
    this.showSpinner = false,
  });

  final IconData? icon;
  final String text;
  final bool showSpinner;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    return Row(
      children: [
        if (showSpinner)
          const SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator(strokeWidth: 2),
          )
        else
          Icon(icon, size: 16, color: tokens.textTertiary),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            text,
            style: theme.textTheme.bodySmall?.copyWith(
              color: tokens.textSecondary,
            ),
          ),
        ),
      ],
    );
  }
}

enum _QuotaWindowKind { fiveHour, weekly, other }

/// Canonical window kind from a Tokdash bucket id. Mirrors Tokdash's own
/// client convention (`session`/`five_hour`/`5h` → 5-hour,
/// `weekly_all`/`seven_day`/`7d`/`plan` → weekly) without branching on
/// provider names. Scoped weekly buckets such as `weekly_scoped_fable` are
/// distinct quota pools and fall through to their server-provided label.
_QuotaWindowKind _quotaWindowKind(String bucketId) {
  final id = bucketId.toLowerCase();
  if (id == '5h' ||
      id == 'five_hour' ||
      id == 'session' ||
      id.endsWith('_5h')) {
    return _QuotaWindowKind.fiveHour;
  }
  if (id == '7d' ||
      id == 'seven_day' ||
      id == 'plan' ||
      id == 'weekly' ||
      id == 'weekly_all' ||
      id.endsWith('_7d')) {
    return _QuotaWindowKind.weekly;
  }
  return _QuotaWindowKind.other;
}

/// Window label for a MODEL-SCOPED quota pool, or `null` for the pooled
/// windows. Tokdash reports per-model limits beside the shared ones — Codex
/// ships `codex_<model>_5h`/`codex_<model>_7d` and Claude ships
/// `weekly_scoped_<model>` — and rendering those through the generic
/// "5-hour"/"Weekly" labels produced two indistinguishable rows per window.
/// The scoped row names its model instead: "Sparks 5h", "Sparks Weekly".
String? _scopedWindowLabel(
  String providerId,
  TokdashQuotaBucket bucket,
  AppLocalizations l10n,
) {
  final id = bucket.bucket.toLowerCase();
  switch (providerId.toLowerCase()) {
    case 'codex':
      final match = RegExp(r'^codex_(.+)_(5h|7d)$').firstMatch(id);
      if (match == null) return null;
      final model = quotaScopedModelDisplayName(
        match.group(1)!,
        bucket.bucketLabel,
      );
      return match.group(2) == '5h'
          ? l10n.settingsQuotaWindowScopedFiveHour(model)
          : l10n.settingsQuotaWindowScopedWeekly(model);
    case 'claude':
      final match = RegExp(r'^weekly_scoped_(.+)$').firstMatch(id);
      if (match == null) return null;
      return l10n.settingsQuotaWindowScopedWeekly(
        quotaScopedModelDisplayName(match.group(1)!, bucket.bucketLabel),
      );
  }
  return null;
}

/// Display name for a model-scoped quota pool. Model names are brand names,
/// exempt from translation. Unknown scopes fall back to the server label's
/// model prefix (Tokdash writes "GPT-5.3-Codex-Spark · 5-hour"), then to
/// capitalizing the scope id.
String quotaScopedModelDisplayName(String scopeId, String bucketLabel) {
  switch (scopeId.toLowerCase()) {
    case 'bengalfox':
      return 'Sparks';
    case 'fable':
      return 'Fable';
    case 'opus':
      return 'Opus';
    case 'sonnet':
      return 'Sonnet';
  }
  final separator = bucketLabel.indexOf(' \u00b7 ');
  if (separator > 0) return bucketLabel.substring(0, separator);
  if (scopeId.isEmpty) return scopeId;
  return scopeId[0].toUpperCase() + scopeId.substring(1);
}

/// Display name for a Tokdash provider id. Brand/tool names are exempt from
/// translation; unknown future providers fall back to capitalization.
String quotaProviderDisplayName(String providerId) {
  switch (providerId.toLowerCase()) {
    case 'codex':
      return 'Codex';
    case 'claude':
      return 'Claude';
    case 'antigravity':
      return 'Antigravity';
    case 'minimax':
      return 'MiniMax';
    case 'kimi':
      return 'Kimi';
    case 'grok':
      return 'Grok';
    default:
      if (providerId.isEmpty) return providerId;
      return providerId[0].toUpperCase() + providerId.substring(1);
  }
}

/// Severity color for a remaining-percent reading: critical at or under 10%,
/// warning at or under 25%, otherwise healthy.
Color quotaSeverityColor(AppTokens tokens, num remainingPercent) {
  if (remainingPercent <= quotaCriticalRemainingPercent) {
    return tokens.statusError;
  }
  if (remainingPercent <= quotaWarningRemainingPercent) {
    return tokens.statusNeedsInput;
  }
  return tokens.statusWorking;
}

/// Relative reset-time copy ("Resets in 3 h" / "Resets soon").
String quotaResetCopy(AppLocalizations l10n, DateTime now, DateTime resetsAt) {
  final delta = resetsAt.difference(now);
  if (delta.isNegative || delta.inMinutes < 1) {
    return l10n.settingsQuotaResetsSoon;
  }
  if (delta.inHours < 1) {
    return l10n.settingsQuotaResetsInMinutes(delta.inMinutes);
  }
  if (delta.inDays < 1) {
    return l10n.settingsQuotaResetsInHours(delta.inHours);
  }
  return l10n.settingsQuotaResetsInDays(delta.inDays);
}

/// Relative freshness copy ("Updated 12 min ago").
String quotaUpdatedCopy(
  AppLocalizations l10n,
  DateTime now,
  DateTime captured,
) {
  final age = now.difference(captured);
  if (age.isNegative || age.inSeconds < 60) {
    return l10n.settingsQuotaUpdatedJustNow;
  }
  if (age.inHours < 1) {
    return l10n.settingsQuotaUpdatedMinutesAgo(age.inMinutes);
  }
  if (age.inDays < 1) {
    return l10n.settingsQuotaUpdatedHoursAgo(age.inHours);
  }
  return l10n.settingsQuotaUpdatedDaysAgo(age.inDays);
}
