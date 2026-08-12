import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// A literal command or path that can be selected or copied exactly.
///
/// Long values scroll horizontally instead of truncating. The copy action uses
/// a compact desktop target and a larger target on touch-first platforms.
class CopyableCodeLine extends StatelessWidget {
  /// Creates a copyable literal line.
  const CopyableCodeLine({
    required this.text,
    required this.copyTooltip,
    required this.copiedMessage,
    this.heading,
    this.padding = const EdgeInsets.only(left: 8),
    this.enabled = true,
    this.copyButtonKey,
    this.copyFailedMessage,
    this.afterCopy,
    super.key,
  });

  /// The exact value shown and copied.
  final String text;

  /// Accessible label for the copy action.
  final String copyTooltip;

  /// Confirmation shown after copying.
  final String copiedMessage;

  /// Optional first line for dense two-line rows.
  ///
  /// The heading and literal then share the copy target's 32/40dp height. This
  /// keeps an existing two-line row layout-neutral instead of stacking a copy
  /// button below its heading and growing the row.
  final Widget? heading;

  /// Insets inside the decorated copy surface.
  final EdgeInsetsGeometry padding;

  /// Whether the copy action is currently available.
  final bool enabled;

  /// Optional stable key for the trailing copy button.
  final Key? copyButtonKey;

  /// Optional localized failure shown when the platform clipboard rejects.
  final String? copyFailedMessage;

  /// Optional feature callback after a successful clipboard write.
  ///
  /// The returned text replaces [copiedMessage], allowing a feature to report
  /// a coupled state transition without duplicating the copy surface.
  final Future<String?> Function()? afterCopy;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final theme = Theme.of(context);
    final targetSize = switch (theme.platform) {
      TargetPlatform.android || TargetPlatform.iOS => 40.0,
      _ => 32.0,
    };

    return Container(
      width: double.infinity,
      padding: padding,
      decoration: BoxDecoration(
        color: tokens.surface2,
        borderRadius: BorderRadius.circular(tokens.radiusSm),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (heading case final heading?) heading,
                SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: SelectableText(
                    text,
                    maxLines: 1,
                    style: theme.textTheme.bodySmall?.copyWith(
                      color: tokens.textPrimary,
                      fontFamily: 'monospace',
                    ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 4),
          IconButton(
            key: copyButtonKey,
            tooltip: copyTooltip,
            onPressed: !enabled
                ? null
                : () async {
                    try {
                      await Clipboard.setData(ClipboardData(text: text));
                    } on PlatformException {
                      if (!context.mounted || copyFailedMessage == null) return;
                      ScaffoldMessenger.of(context)
                        ..hideCurrentSnackBar()
                        ..showSnackBar(
                          SnackBar(content: Text(copyFailedMessage!)),
                        );
                      return;
                    }
                    final confirmation =
                        await afterCopy?.call() ?? copiedMessage;
                    if (!context.mounted) return;
                    ScaffoldMessenger.of(context)
                      ..hideCurrentSnackBar()
                      ..showSnackBar(SnackBar(content: Text(confirmation)));
                  },
            icon: const Icon(Icons.copy_outlined, size: 14),
            style: IconButton.styleFrom(
              foregroundColor: tokens.textSecondary,
              padding: EdgeInsets.zero,
              minimumSize: Size.square(targetSize),
              maximumSize: Size.square(targetSize),
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            ),
          ),
        ],
      ),
    );
  }
}
