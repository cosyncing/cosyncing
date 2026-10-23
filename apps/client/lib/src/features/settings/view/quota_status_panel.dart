import 'dart:math' as math;

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/window_size_class.dart';
import 'package:cosyncing_client/src/features/settings/view/quota_liquid_gauge.dart';
import 'package:cosyncing_client/src/features/settings/view/quota_provider_logo.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:flutter/material.dart';

/// Remaining-percent threshold at or under which a quota row reads as a
/// warning. Matches the broker's quota-warning evaluator
/// (`packages/typescript/broker/src/installation/tokdash-quota.ts`).
const double quotaWarningRemainingPercent = 25;

/// Remaining-percent threshold at or under which a quota row reads as
/// critical — a presentation-only escalation of the same warning signal.
const double quotaCriticalRemainingPercent = 10;

/// How close to its expiry a reset credit is use-or-lose. Tokdash arms its
/// own expiry notice inside the last 48 hours, the edge included.
const Duration quotaResetCreditsUseOrLose = Duration(hours: 48);

/// Remaining quota in compact provider pairs, with one liquid circle per
/// window. Provider selection, window normalization, stale/estimated readings
/// and reset credits share the same presentation in Overview and Settings.
/// Antigravity retains its two shared pools rather than repeating each model.
class QuotaStatusPanel extends StatelessWidget {
  /// Creates a quota panel.
  ///
  /// [quota] is the latest broker-proxied snapshot; `null` means the read
  /// failed. [now] is injectable for deterministic tests.
  const QuotaStatusPanel({
    this.quota,
    this.loading = false,
    this.now,
    this.selectedProviders,
    this.embedded = false,
    super.key,
  });

  /// Latest quota snapshot, or `null` when the read failed.
  final TokdashQuotaResponse? quota;

  /// Whether the first snapshot is still being read.
  final bool loading;

  /// Reference clock for relative reset copy.
  final DateTime? now;

  /// Optional ordered subset for the workspace Overview.
  final List<String>? selectedProviders;

  /// Omits the Settings wrapper on an already titled reading surface.
  final bool embedded;

  /// Content width from which providers sit two to a row.
  static const double twoColumnWidth = 280;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final now = this.now ?? DateTime.now();

    if (embedded) {
      return loading
          ? InlineNotice(text: l10n.settingsQuotaLoading, showSpinner: true)
          : _buildContent(context, l10n, now);
    }

    // Everything below is REMAINING allowance in rolling windows, never a sum
    // of what was used; the usage report owns that figure.
    return SelectionArea(
      child: SettingsSection(
        key: const Key('settings-quota-panel'),
        title: l10n.settingsQuotaPanelTitle,
        description: l10n.settingsQuotaReadOnlyNote,
        child: Padding(
          padding: const EdgeInsets.only(top: 8),
          child: loading
              ? InlineNotice(text: l10n.settingsQuotaLoading, showSpinner: true)
              : _buildContent(context, l10n, now),
        ),
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
      return InlineNotice(
        icon: Icons.cloud_off_outlined,
        text: l10n.settingsQuotaUnavailable,
      );
    }
    if (!data.enabled) {
      return InlineNotice(
        icon: Icons.toggle_off_outlined,
        text: l10n.settingsQuotaMonitoringOff,
      );
    }

    final groups = <Widget>[];
    final providerIds =
        selectedProviders ?? (data.providers.keys.toList()..sort());
    for (final providerId in providerIds) {
      final provider =
          data.providers[providerId] ??
          TokdashQuotaProvider.empty(provider: providerId);
      if (selectedProviders == null &&
          !quotaProviderHasPresentation(provider)) {
        continue;
      }
      groups.add(
        _QuotaProviderGroup(
          providerId: providerId,
          provider: provider,
          now: now,
        ),
      );
    }
    if (groups.isEmpty) {
      return InlineNotice(
        icon: Icons.cloud_off_outlined,
        text: l10n.settingsQuotaUnavailable,
      );
    }
    return QuotaLiquidMotion(
      enabled: providerIds.any(
        (id) =>
            data.providers[id]?.buckets.any(
              (bucket) =>
                  bucket.remainingPercent != null &&
                  bucket.remainingPercent! > 0 &&
                  bucket.remainingPercent! < 100,
            ) ??
            false,
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          final scale = MediaQuery.textScalerOf(context).scale(12) / 12;
          final columns =
              constraints.maxWidth >= twoColumnWidth * math.max(1, scale)
              ? 2
              : 1;
          final gap = WindowSizeClass.of(context) == WindowSizeClass.compact
              ? 12.0
              : 16.0;
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                l10n.settingsQuotaRemainingLegend,
                style: Theme.of(context).textTheme.labelSmall?.copyWith(
                  color: context.tokens.textSecondary,
                ),
              ),
              const SizedBox(height: 8),
              for (var start = 0; start < groups.length; start += columns) ...[
                if (start > 0) SizedBox(height: gap),
                if (columns == 1)
                  groups[start]
                else
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Expanded(child: groups[start]),
                      SizedBox(width: gap),
                      Expanded(
                        child: start + 1 < groups.length
                            ? groups[start + 1]
                            : const SizedBox.shrink(),
                      ),
                    ],
                  ),
              ],
            ],
          );
        },
      ),
    );
  }
}

/// Readings and meaningful failures, excluding empty provider shells.
bool quotaProviderHasPresentation(TokdashQuotaProvider provider) =>
    !(provider.buckets.isEmpty &&
        provider.status == 'unavailable' &&
        !(provider.statusDetail?.isNotEmpty ?? false));

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

    final buckets = _quotaBucketsForPresentation(
      providerId,
      provider.buckets,
      l10n,
    );

    return Container(
      key: Key('settings-quota-provider-$providerId'),
      padding: const EdgeInsets.all(8),
      decoration: BoxDecoration(
        border: Border.all(color: tokens.separator),
        borderRadius: BorderRadius.circular(tokens.radiusMd),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              QuotaProviderLogo(provider: provider.provider),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  providerName,
                  style: theme.textTheme.labelLarge?.copyWith(
                    color: tokens.textPrimary,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          if (provider.estimated || failed) ...[
            const SizedBox(height: 4),
            Wrap(
              spacing: 4,
              runSpacing: 4,
              children: [
                if (provider.estimated)
                  StatusPill(
                    label: l10n.settingsQuotaEstimated,
                    color: tokens.statusIdle,
                    dense: true,
                  ),
                if (failed)
                  StatusPill(
                    label: l10n.settingsQuotaStale,
                    color: tokens.statusNeedsInput,
                    dense: true,
                  ),
              ],
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
              if (index > 0) const SizedBox(height: 8),
              _QuotaBucketRow(
                providerName: providerName,
                providerId: providerId,
                bucket: buckets[index].bucket,
                bucketKey: buckets[index].key,
                groupLabel: buckets[index].groupLabel,
                windowLabelOverride: buckets[index].windowLabel,
                estimated: provider.estimated,
                stale: failed || buckets[index].bucket.status != 'ok',
                showStalePill: !failed && buckets[index].bucket.status != 'ok',
                now: now,
              ),
            ],
          if (_spendableResetCredits(provider) case final credits?) ...[
            const SizedBox(height: 12),
            _QuotaResetCreditsRow(
              providerName: providerName,
              providerId: providerId,
              credits: credits,
              now: now,
            ),
          ],
        ],
      ),
    );
  }
}

/// A provider's reset credits when at least one can be spent. Tokdash keeps
/// the block on an account that has spent its last, with a count of 0.
TokdashResetCredits? _spendableResetCredits(TokdashQuotaProvider provider) {
  final credits = provider.resetCredits;
  return credits != null && credits.availableCount >= 1 ? credits : null;
}

/// A provider's reset credits, under its windows: how many can be spent and
/// when the soonest expires. A count, not a window, so it carries no bar. The
/// expiry turns amber once a credit is use-or-lose.
class _QuotaResetCreditsRow extends StatelessWidget {
  const _QuotaResetCreditsRow({
    required this.providerName,
    required this.providerId,
    required this.credits,
    required this.now,
  });

  final String providerName;
  final String providerId;
  final TokdashResetCredits credits;
  final DateTime now;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final count = credits.availableCount;
    final available = l10n.settingsQuotaResetCreditsAvailable(count);
    final expiry = credits.nextExpiry(now);
    final expiryCopy = expiry == null
        ? null
        : quotaResetCreditsExpiryCopy(l10n, now, expiry, count);
    final useOrLose =
        expiry != null && expiry.difference(now) <= quotaResetCreditsUseOrLose;

    return Semantics(
      key: Key('settings-quota-reset-credits-$providerId'),
      container: true,
      label: [
        '$providerName ${l10n.settingsQuotaResetCredits}',
        available,
        ?expiryCopy,
      ].join(', '),
      child: ExcludeSemantics(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Wrap(
              spacing: 8,
              runSpacing: 4,
              children: [
                Text(
                  l10n.settingsQuotaResetCredits,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: tokens.textPrimary,
                  ),
                ),
                Text(
                  available,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: tokens.textSecondary,
                  ),
                ),
              ],
            ),
            if (expiryCopy != null) ...[
              const SizedBox(height: 4),
              Text(
                expiryCopy,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: useOrLose
                      ? tokens.statusNeedsInput
                      : tokens.textTertiary,
                ),
              ),
            ],
          ],
        ),
      ),
    );
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
          a,
        ).index.compareTo(_quotaWindowKind(b).index);
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

/// One window: liquid reserve, complete window label and reset countdown.
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
        child: Row(
          children: [
            Tooltip(
              message: remaining == null
                  ? l10n.settingsQuotaNoReadings
                  : l10n.settingsQuotaPercentRemaining('${remaining.round()}'),
              child: QuotaLiquidGauge(
                remaining: remaining?.toDouble(),
                color: severityColor,
              ),
            ),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (groupLabel case final group?) ...[
                    Text(
                      group,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: tokens.textPrimary,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 4),
                  ],
                  Text(
                    windowLabel,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: tokens.textPrimary,
                    ),
                  ),
                  if (remaining == null) ...[
                    const SizedBox(height: 4),
                    Text(
                      l10n.settingsQuotaNoReadings,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: tokens.textTertiary,
                      ),
                    ),
                  ],
                  if (resetCopy != null) ...[
                    const SizedBox(height: 4),
                    Text(
                      resetCopy,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: tokens.textSecondary,
                      ),
                    ),
                  ],
                  if (showStalePill) ...[
                    const SizedBox(height: 4),
                    StatusPill(
                      label: l10n.settingsQuotaStale,
                      color: tokens.statusNeedsInput,
                      dense: true,
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _windowLabel(AppLocalizations l10n) {
    switch (_quotaWindowKind(bucket)) {
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

enum _QuotaWindowKind { fiveHour, weekly, other }

/// Canonical window kind of a Tokdash bucket. Mirrors Tokdash's own client
/// convention by id (`session`/`five_hour`/`5h` → 5-hour,
/// `weekly_all`/`seven_day`/`7d`/`plan` → weekly) without branching on
/// provider names. A five-hour window under any other id is recognized by
/// the label its provider gives it — OpenCode Go reports `rolling` as
/// "Rolling (5h)" — so every five-hour window reads "5-hour". Scoped weekly
/// buckets such as `weekly_scoped_fable` are distinct quota pools and fall
/// through to their server-provided label.
_QuotaWindowKind _quotaWindowKind(TokdashQuotaBucket bucket) {
  final id = bucket.bucket.toLowerCase();
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
  if (_fiveHourLabel.hasMatch(bucket.bucketLabel)) {
    return _QuotaWindowKind.fiveHour;
  }
  return _QuotaWindowKind.other;
}

/// "5h", "5 h", "5-hour", "5 hours", "five-hour", "five hour" as a whole
/// word, in any case; never "15h" or "25-hour".
final RegExp _fiveHourLabel = RegExp(
  r'(?<![\w.])(?:5\s*-?\s*h(?:ours?|rs?)?|five[\s-]*hours?)\b',
  caseSensitive: false,
);

/// Window label for a MODEL-SCOPED quota pool, or `null` for the pooled
/// windows. Tokdash reports per-model limits beside the shared ones — Codex
/// ships `codex_<model>_5h`/`codex_<model>_7d` and Claude ships
/// `weekly_scoped_<model>` — and rendering those through the generic
/// "5-hour"/"Weekly" labels produced two indistinguishable rows per window.
/// The scoped row names its model instead: "Sparks 5-hour", "Sparks Weekly".
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
    case 'commandcode':
      return 'Command Code';
    case 'zai':
      return 'Z.ai';
    case 'opencode_go':
      return 'OpenCode Go';
    default:
      if (providerId.isEmpty) return providerId;
      return providerId[0].toUpperCase() + providerId.substring(1);
  }
}

/// Color for a remaining-percent reading: critical at or under 10%, warning
/// at or under 25%, otherwise the healthy reserve color.
Color quotaSeverityColor(AppTokens tokens, num remainingPercent) {
  if (remainingPercent <= quotaCriticalRemainingPercent) {
    return tokens.statusError;
  }
  if (remainingPercent <= quotaWarningRemainingPercent) {
    return tokens.statusNeedsInput;
  }
  return tokens.statusWorking;
}

/// When the soonest of [count] reset credits expires, by Tokdash's companion
/// rule: whole days remaining from two up, "tomorrow" inside two days,
/// "today" inside one.
String quotaResetCreditsExpiryCopy(
  AppLocalizations l10n,
  DateTime now,
  DateTime expiresAt,
  int count,
) {
  final days = expiresAt.difference(now).inDays;
  if (days < 1) return l10n.settingsQuotaResetCreditsExpireToday(count);
  if (days < 2) return l10n.settingsQuotaResetCreditsExpireTomorrow(count);
  return l10n.settingsQuotaResetCreditsExpireInDays(count, days);
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
