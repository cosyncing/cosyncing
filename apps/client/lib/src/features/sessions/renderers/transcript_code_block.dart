part of 'message_renderer_registry.dart';

/// Boxed monospace block used for terminal output and fenced code blocks.
///
/// Uses a plain [Text] rather than [SelectableText]: every transcript message
/// already sits inside the transcript-level [SelectionArea], and a nested
/// [SelectableText] would create its own selection island that a drag starting
/// in surrounding prose could not extend into.
class _MonospaceDetailSection extends StatelessWidget {
  const _MonospaceDetailSection({
    required this.sourceId,
    required this.text,
    this.keyPrefix = 'terminal-output-body',
    this.codeLanguage,
  });

  final String sourceId;
  final String text;

  /// Fenced-code language label. Null keeps terminal output unhighlighted.
  final String? codeLanguage;

  /// Key namespace. Defaults to the terminal-output value so existing keys are
  /// unchanged; markdown code blocks pass their own prefix.
  final String keyPrefix;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final language = codeLanguage;
    if (language == null) {
      // Preserve the established terminal/structured-message rendering path.
      return Container(
        key: ValueKey('$keyPrefix-$sourceId'),
        width: double.infinity,
        decoration: BoxDecoration(
          color: theme.colorScheme.surface,
          border: Border.all(color: theme.colorScheme.outline),
          borderRadius: BorderRadius.circular(8),
        ),
        padding: const EdgeInsets.all(8),
        child: Text(
          text,
          style: theme.textTheme.bodySmall?.copyWith(
            fontFamily: 'monospace',
            height: 1.2,
          ),
        ),
      );
    }
    final tokens = context.tokens;
    final baseStyle = theme.textTheme.bodySmall?.copyWith(
      color: tokens.textPrimary,
      fontFamily: 'monospace',
      height: 1.5,
    );
    final highlighted = highlightTranscriptCode(text, language: language);
    return Container(
      key: ValueKey('$keyPrefix-$sourceId'),
      width: double.infinity,
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: tokens.surface2,
        border: Border.all(color: tokens.separator),
        borderRadius: BorderRadius.circular(tokens.radiusSm),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // The header carries chrome, not source: keep it out of the
          // transcript-level SelectionArea so a cross-message drag copies
          // exactly the authored code and prose.
          SelectionContainer.disabled(
            child: SizedBox(
              height: 40,
              child: Row(
                children: [
                  const SizedBox(width: 12),
                  Expanded(
                    child: language.isEmpty
                        ? const SizedBox.shrink()
                        : Text(
                            language,
                            key: ValueKey('$keyPrefix-$sourceId-language'),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.labelSmall?.copyWith(
                              color: tokens.textSecondary,
                            ),
                          ),
                  ),
                  IconButton(
                    key: ValueKey('$keyPrefix-$sourceId-copy'),
                    tooltip: AppLocalizations.of(context).transcriptCodeCopy,
                    onPressed: () => unawaited(_copyExactSource(context)),
                    icon: const Icon(Icons.content_copy, size: 16),
                    style: IconButton.styleFrom(
                      foregroundColor: tokens.textSecondary,
                      padding: EdgeInsets.zero,
                      minimumSize: const Size(40, 40),
                      maximumSize: const Size(40, 40),
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                  ),
                ],
              ),
            ),
          ),
          Container(height: 1, color: tokens.separator),
          Padding(
            padding: const EdgeInsets.all(12),
            child: Text.rich(
              key: ValueKey('$keyPrefix-$sourceId-code'),
              TextSpan(
                style: baseStyle,
                children: [
                  for (final token in highlighted)
                    TextSpan(
                      text: token.text,
                      style: baseStyle?.copyWith(
                        color: switch (token.kind) {
                          TranscriptCodeTokenKind.plain => tokens.textPrimary,
                          TranscriptCodeTokenKind.keyword =>
                            tokens.syntaxKeyword,
                          TranscriptCodeTokenKind.string => tokens.syntaxString,
                          TranscriptCodeTokenKind.number => tokens.syntaxNumber,
                          TranscriptCodeTokenKind.comment =>
                            tokens.syntaxComment,
                          TranscriptCodeTokenKind.literal =>
                            tokens.syntaxLiteral,
                          TranscriptCodeTokenKind.operator =>
                            tokens.textSecondary,
                        },
                        fontStyle: token.kind == TranscriptCodeTokenKind.comment
                            ? FontStyle.italic
                            : FontStyle.normal,
                        fontWeight:
                            token.kind == TranscriptCodeTokenKind.keyword
                            ? FontWeight.w600
                            : FontWeight.normal,
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  /// Copies the exact authored fence body — the same string the parser
  /// preserved byte-for-byte — through the app's one clipboard path.
  Future<void> _copyExactSource(BuildContext context) async {
    final confirmation = AppLocalizations.of(context).transcriptCodeCopied;
    final messenger = ScaffoldMessenger.maybeOf(context);
    await Clipboard.setData(ClipboardData(text: text));
    messenger?.showSnackBar(SnackBar(content: Text(confirmation)));
  }
}
