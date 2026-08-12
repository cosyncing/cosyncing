import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:flutter/material.dart';

/// Visual tone for compact boxed transcript content.
enum TranscriptBoxTone {
  /// Neutral requests and other informational boxed content.
  neutral,

  /// A broker-reported session error.
  error,
}

/// Shared tinted-card shell for compact boxed transcript content.
///
/// The shell deliberately owns presentation only. Feature code maps wire
/// message families to a [TranscriptBoxTone] and supplies all content and
/// actions. It contains no selection widget because the transcript owns one
/// continuous selection region across messages.
class TranscriptBox extends StatelessWidget {
  /// Creates a compact transcript box.
  const TranscriptBox({
    required this.tone,
    required this.icon,
    required this.title,
    this.body,
    this.trailing,
    this.actions = const [],
    super.key,
  });

  /// Tint and title/icon color family.
  final TranscriptBoxTone tone;

  /// Outlined icon that identifies the message family without color alone.
  final IconData icon;

  /// Localized box heading.
  final String title;

  /// Plain transcript content inside the parent transcript selection region.
  final Widget? body;

  /// Optional quiet metadata at the end of the heading row.
  final Widget? trailing;

  /// Optional compact actions, wrapped at narrow widths and high text scales.
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final theme = Theme.of(context);
    final isError = tone == TranscriptBoxTone.error;
    final fill = isError
        ? theme.colorScheme.errorContainer.withValues(alpha: 0.35)
        : theme.colorScheme.surfaceContainerHighest;
    final titleColor = isError
        ? _readableErrorForeground(tokens, fill)
        : tokens.textPrimary;

    return Card(
      color: fill,
      margin: const EdgeInsets.fromLTRB(8, 8, 8, 0),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(tokens.radiusLg),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ExcludeSemantics(
                  child: Icon(
                    icon,
                    size: 16,
                    color: isError ? titleColor : tokens.textSecondary,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    title,
                    style: theme.textTheme.titleSmall?.copyWith(
                      color: titleColor,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                if (trailing != null) ...[
                  const SizedBox(width: 8),
                  trailing!,
                ],
              ],
            ),
            if (body != null) ...[
              const SizedBox(height: 4),
              DefaultTextStyle(
                style: theme.textTheme.bodySmall!.copyWith(
                  color: tokens.textPrimary,
                ),
                child: body!,
              ),
            ],
            if (actions.isNotEmpty) ...[
              const SizedBox(height: 4),
              Align(
                alignment: AlignmentDirectional.centerEnd,
                child: Wrap(
                  alignment: WrapAlignment.end,
                  spacing: 8,
                  runSpacing: 4,
                  children: actions,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

Color _readableErrorForeground(AppTokens tokens, Color translucentFill) {
  final backgrounds = <Color>[
    Color.alphaBlend(translucentFill, tokens.canvas),
    Color.alphaBlend(translucentFill, tokens.surface),
  ];
  for (var step = 0; step <= 20; step += 1) {
    final candidate = Color.lerp(
      tokens.statusError,
      tokens.textPrimary,
      step / 20,
    )!;
    if (backgrounds.every(
      (background) => _contrast(candidate, background) >= 4.5,
    )) {
      return candidate;
    }
  }
  return tokens.textPrimary;
}

double _contrast(Color foreground, Color background) {
  final foregroundLuminance = foreground.computeLuminance();
  final backgroundLuminance = background.computeLuminance();
  final lighter = foregroundLuminance > backgroundLuminance
      ? foregroundLuminance
      : backgroundLuminance;
  final darker = foregroundLuminance > backgroundLuminance
      ? backgroundLuminance
      : foregroundLuminance;
  return (lighter + 0.05) / (darker + 0.05);
}
