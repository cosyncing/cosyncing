import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/usage/model/usage_format.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_figures.dart';
import 'package:flutter/material.dart';

/// Opens the complete supplied breakdown; absent measurements stay unknown.
Future<void> showUsageDetailDialog(
  BuildContext context, {
  required String title,
  required String locale,
  required double tokens,
  required double cost,
  double? input,
  double? output,
  double? cache,
  int? messages,
  int? sessions,
  double? activeMs,
}) {
  final l10n = AppLocalizations.of(context);
  String count(num? value) =>
      value == null ? '—' : formatUsageCount(value, locale: locale);
  return showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      title: SelectableText(title),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            UsageFigureRow(label: l10n.usageTokensLabel, value: count(tokens)),
            UsageFigureRow(label: l10n.usageColIn, value: count(input)),
            UsageFigureRow(label: l10n.usageColOut, value: count(output)),
            UsageFigureRow(label: l10n.usageColCache, value: count(cache)),
            UsageFigureRow(
              label: l10n.usageStatMessages,
              value: count(messages),
            ),
            UsageFigureRow(
              label: l10n.usageColSessions,
              value: count(sessions),
            ),
            UsageFigureRow(
              label: l10n.usageColCost,
              value: formatUsageCost(cost, locale: locale),
            ),
            UsageFigureRow(
              label: l10n.usageColActive,
              value: activeMs == null
                  ? '—'
                  : formatUsageAgentTime(activeMs, locale: locale),
            ),
            const SizedBox(height: 12),
            UsageFootnote(text: l10n.usageEnhancementDetailUnavailable),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: Text(l10n.close),
        ),
      ],
    ),
  );
}
