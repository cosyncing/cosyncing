/// Shared presentation pieces for the usage surfaces.
///
/// The Settings card, the report page and the export cards render the same
/// figures at three densities. These widgets are what keep them one system, so
/// a number cannot pick up a different weight or alignment by being on a
/// different screen.
library;

import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:flutter/material.dart';

/// A label on the left, a figure on the right, and an optional quiet sub-line.
class UsageFigureRow extends StatelessWidget {
  /// Creates a figure row.
  const UsageFigureRow({
    required this.label,
    required this.value,
    this.detail,
    this.trailing,
    this.tooltip,
    super.key,
  });

  /// Row label.
  final String label;

  /// The figure.
  final String value;

  /// Supporting line under the figure, such as a token split or a delta.
  final String? detail;

  /// Widget after the figure, such as an estimated pill.
  final Widget? trailing;

  /// Explanation attached to the label, such as how a figure is estimated.
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final labelText = Text(
      label,
      style: theme.textTheme.bodyMedium?.copyWith(color: tokens.textSecondary),
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: tooltip == null
                    ? labelText
                    : Tooltip(message: tooltip, child: labelText),
              ),
              const SizedBox(width: 12),
              Flexible(
                child: Text(
                  value,
                  textAlign: TextAlign.end,
                  style: theme.textTheme.labelMedium?.copyWith(
                    fontWeight: FontWeight.w600,
                    // Column-aligned digits, so a changing figure does not
                    // shuffle everything beside it.
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ),
              if (trailing != null) ...[const SizedBox(width: 8), trailing!],
            ],
          ),
          if (detail != null)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Text(
                detail!,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: tokens.textTertiary,
                  fontFeatures: const [FontFeature.tabularFigures()],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// A fractional-width fill over the surface, used for every share bar.
///
/// A `Container`, not a chart library: the design closed without a package
/// dependency and these bars are one rectangle over another.
class UsageShareBar extends StatelessWidget {
  /// Creates a share bar.
  const UsageShareBar({required this.fraction, this.height = 6, super.key});

  /// Share of the total, 0..1. Values outside are clamped rather than refused.
  final double fraction;

  /// Bar thickness.
  final double height;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final safe = fraction.isFinite ? fraction.clamp(0.0, 1.0) : 0.0;
    return ClipRRect(
      borderRadius: BorderRadius.circular(tokens.radiusXs),
      child: Container(
        height: height,
        color: tokens.surface2,
        child: FractionallySizedBox(
          alignment: Alignment.centerLeft,
          widthFactor: safe,
          child: ColoredBox(color: tokens.accent),
        ),
      ),
    );
  }
}

/// A section heading in the usage surfaces' quiet register.
class UsageSectionTitle extends StatelessWidget {
  /// Creates a section title.
  const UsageSectionTitle({required this.title, this.suffix, super.key});

  /// The heading.
  final String title;

  /// Quiet qualifier after the heading, such as the served time zone.
  final String? suffix;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.baseline,
        textBaseline: TextBaseline.alphabetic,
        children: [
          Flexible(
            child: Text(
              title,
              style: theme.textTheme.labelLarge?.copyWith(
                color: tokens.textSecondary,
              ),
            ),
          ),
          if (suffix != null) ...[
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                suffix!,
                style: theme.textTheme.bodySmall?.copyWith(
                  color: tokens.textTertiary,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// A quiet caveat line, for the notes these surfaces must always print.
class UsageFootnote extends StatelessWidget {
  /// Creates a footnote.
  const UsageFootnote({required this.text, this.center = false, super.key});

  /// The note.
  final String text;

  /// Whether to centre it, as the report footer does.
  final bool center;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Text(
      text,
      textAlign: center ? TextAlign.center : TextAlign.start,
      style: theme.textTheme.bodySmall?.copyWith(
        color: context.tokens.textTertiary,
      ),
    );
  }
}
