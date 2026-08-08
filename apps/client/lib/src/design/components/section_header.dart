import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:flutter/material.dart';

/// A titled section divider for settings and grouped list surfaces.
///
/// Renders [title] in the accent color with the standard section padding so
/// grouped content reads as one labelled section across the app.
class SectionHeader extends StatelessWidget {
  /// Creates a section header labelled [title].
  const SectionHeader(
    this.title, {
    this.padding = const EdgeInsets.fromLTRB(16, 16, 16, 8),
    super.key,
  });

  /// The section title text.
  final String title;

  /// Padding around the title.
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: padding,
      child: Text(
        title,
        style: theme.textTheme.titleSmall?.copyWith(
          color: context.tokens.accent,
        ),
      ),
    );
  }
}
