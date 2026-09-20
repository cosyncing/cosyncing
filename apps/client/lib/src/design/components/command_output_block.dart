import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:flutter/material.dart';

/// Bounded monospace view of a command's output, newest line last.
///
/// The kit owns presentation only. Callers supply text that is ALREADY bounded
/// and say whether earlier bytes were dropped; nothing here fetches, trims or
/// reformats output, and no semantic color is resolved inside.
///
/// It contains no selection widget. Surfaces that show this already own one
/// continuous selection region, and a nested selectable would create an island
/// a drag starting outside could not extend into.
class CommandOutputBlock extends StatelessWidget {
  /// Creates a bounded output block.
  const CommandOutputBlock({
    required this.text,
    this.truncated = false,
    this.truncationLabel,
    this.maxLines,
    super.key,
  });

  /// Key for the output body, exposed for visual contract tests.
  static const bodyKey = Key('command-output-body');

  /// Key for the dropped-bytes marker, exposed for visual contract tests.
  static const truncationKey = Key('command-output-truncation');

  /// Already-bounded output. The caller decides how much is retained.
  final String text;

  /// Whether leading bytes were dropped. Never presentable as complete output.
  final bool truncated;

  /// Localized marker shown when [truncated]. Omitted when the caller has no
  /// string for it, rather than inventing English inside the kit.
  final String? truncationLabel;

  /// Optional cap on rendered lines, for a surface tighter than the bound.
  final int? maxLines;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final label = truncationLabel;
    final body = Text(
      key: bodyKey,
      text,
      maxLines: maxLines,
      overflow: maxLines == null ? null : TextOverflow.ellipsis,
      style: theme.textTheme.bodySmall?.copyWith(
        fontFamily: 'monospace',
        color: tokens.textSecondary,
        height: 1.35,
      ),
    );
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: tokens.canvas,
        border: Border.all(color: tokens.separator),
        borderRadius: BorderRadius.circular(tokens.radiusSm),
      ),
      padding: const EdgeInsets.all(8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (truncated && label != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(
                key: truncationKey,
                label,
                style: theme.textTheme.bodySmall?.copyWith(
                  fontFamily: 'monospace',
                  color: tokens.textTertiary,
                  fontStyle: FontStyle.italic,
                  height: 1.35,
                ),
              ),
            ),
          body,
        ],
      ),
    );
  }
}
