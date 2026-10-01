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
    this.color,
    this.fontWeight,
    super.key,
  });

  /// The section title text.
  final String title;

  /// Padding around the title.
  final EdgeInsetsGeometry padding;

  /// Optional resolved semantic color for a quiet or status-specific heading.
  final Color? color;

  /// Optional weight, for a heading that must stand apart from rows set in
  /// the same size.
  final FontWeight? fontWeight;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: padding,
      child: Text(
        title,
        style: theme.textTheme.titleSmall?.copyWith(
          color: color ?? context.tokens.accent,
          fontWeight: fontWeight,
        ),
      ),
    );
  }
}
