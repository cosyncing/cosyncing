import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:flutter/material.dart';

/// A compact, color-coded status label.
///
/// A rounded badge whose text and translucent fill both derive from [color].
/// Pass a semantic token (`context.tokens.statusWorking`, `.statusError`, …) so
/// the badge reskins with the active theme and adapts to light/dark. The label
/// text carries the precise meaning; the color carries the severity.
///
/// Replaces the many hand-rolled status chips/badges/pills that each set their
/// own padding, radius and alpha, so status reads consistently app-wide.
class StatusPill extends StatelessWidget {
  /// Creates a status pill showing [label] tinted with [color].
  const StatusPill({
    required this.label,
    required this.color,
    this.icon,
    super.key,
  });

  /// The status text (for example `Working`, `Connected`, `Failed`).
  final String label;

  /// Semantic color for the status; drives both the text and the fill.
  final Color color;

  /// Optional leading icon, drawn in [color] before the label.
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final iconData = icon;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(tokens.radiusSm),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (iconData != null) ...[
            Icon(iconData, size: 12, color: color),
            const SizedBox(width: 4),
          ],
          Text(
            label,
            style: theme.textTheme.labelSmall?.copyWith(
              color: color,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}
