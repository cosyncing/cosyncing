import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:flutter/material.dart';

/// A neutral, low-emphasis chip for a piece of metadata.
///
/// Unlike `StatusPill` this carries no severity — it uses the surface-2 fill
/// for quiet key/value or attribute labels (model name, file size, tool
/// metadata). When [maxWidth] is set the label ellipsizes to stay on one line.
class MetadataChip extends StatelessWidget {
  /// Creates a metadata chip showing [label].
  const MetadataChip({
    required this.label,
    this.maxWidth,
    this.bordered = false,
    super.key,
  });

  /// The metadata text.
  final String label;

  /// Optional maximum width; when set the label ellipsizes on overflow.
  final double? maxWidth;

  /// Whether to draw a hairline border in the separator color.
  final bool bordered;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final limit = maxWidth;
    final chip = Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: tokens.surface2,
        borderRadius: BorderRadius.circular(tokens.radiusSm),
        border: bordered ? Border.all(color: tokens.separator) : null,
      ),
      child: Text(
        label,
        style: theme.textTheme.labelSmall?.copyWith(
          color: tokens.textSecondary,
        ),
        maxLines: 1,
        overflow: limit != null ? TextOverflow.ellipsis : null,
      ),
    );
    if (limit == null) {
      return chip;
    }
    return ConstrainedBox(
      constraints: BoxConstraints(maxWidth: limit),
      child: chip,
    );
  }
}
