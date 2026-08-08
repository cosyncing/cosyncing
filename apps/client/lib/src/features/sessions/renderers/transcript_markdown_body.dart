part of 'message_renderer_registry.dart';

/// Opens an http(s) transcript link when the user taps it.
typedef TranscriptLinkOpener = void Function(Uri uri);

/// Opener invoked when a transcript http/https link is tapped.
///
/// The render layer stays dependency-free: the app wires this once at startup
/// to a real launcher (e.g. `url_launcher`'s `launchUrl`), and tests inject a
/// fake. While null, an http(s) link still renders as a tappable link but the
/// tap is inert, so the render layer never hard-depends on a launcher and never
/// throws. Only http/https links are ever tappable — the scheme gate lives in
/// [isTranscriptHttpUrl]; local paths and other schemes render as plain text.
TranscriptLinkOpener? transcriptLinkOpener;

/// Renders a transcript message body as markdown.
///
/// Parsing is dependency-free (see `transcript_markdown.dart`). Plain text with
/// no markdown syntax renders as a single paragraph with identical characters,
/// so non-markdown senders are unaffected.
///
/// Everything here uses plain [Text]/[Text.rich] rather than [SelectableText] so
/// the transcript-level ancestor [SelectionArea] can extend one selection
/// across messages, prose, list items, and fenced code in a single drag.
/// http(s) links are the one interactive exception: they render as a
/// [WidgetSpan] wrapping a tappable [Text], which keeps the render layer free
/// of any gesture-recognizer or launcher dependency.
class _MarkdownBody extends StatelessWidget {
  const _MarkdownBody({required this.source});

  /// Key namespace for fenced code sections, so tests can target them.
  static const String codeBlockKeyPrefix = 'markdown-code-block';

  /// Raw message text, possibly containing markdown.
  final String source;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final baseStyle = theme.textTheme.bodyMedium ?? const TextStyle();
    final blocks = parseTranscriptMarkdown(source);

    if (blocks.isEmpty) {
      // Whitespace-only bodies still occupy their slot without markup.
      return Text(source, style: baseStyle);
    }

    final children = <Widget>[];
    var codeBlockIndex = 0;
    for (var i = 0; i < blocks.length; i++) {
      if (i > 0) {
        children.add(SizedBox(height: _spacingBefore(blocks[i])));
      }
      final block = blocks[i];
      if (block is MarkdownCodeBlock) {
        children.add(
          _MonospaceDetailSection(
            sourceId: '$codeBlockIndex',
            keyPrefix: codeBlockKeyPrefix,
            text: block.code,
            codeLanguage: block.language,
          ),
        );
        codeBlockIndex++;
        continue;
      }
      children.add(_buildBlock(context, theme, baseStyle, block));
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: children,
    );
  }

  double _spacingBefore(MarkdownBlock block) {
    return switch (block) {
      MarkdownHeading() => 12,
      MarkdownCodeBlock() => 8,
      MarkdownThematicBreak() => 12,
      _ => 8,
    };
  }

  Widget _buildBlock(
    BuildContext context,
    ThemeData theme,
    TextStyle baseStyle,
    MarkdownBlock block,
  ) {
    switch (block) {
      case MarkdownParagraph(:final spans):
        return Text.rich(_inlineSpan(theme, baseStyle, spans));

      case MarkdownHeading(:final level, :final spans):
        return Text.rich(
          _inlineSpan(theme, _headingStyle(theme, baseStyle, level), spans),
        );

      case MarkdownBulletList(:final items):
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final item in items)
              _MarkdownListItem(
                marker: '•',
                markerStyle: baseStyle,
                child: Text.rich(_inlineSpan(theme, baseStyle, item)),
              ),
          ],
        );

      case MarkdownOrderedList(:final items, :final start):
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (var i = 0; i < items.length; i++)
              _MarkdownListItem(
                marker: '${start + i}.',
                markerStyle: baseStyle,
                child: Text.rich(_inlineSpan(theme, baseStyle, items[i])),
              ),
          ],
        );

      case MarkdownBlockquote(:final spans):
        return Container(
          decoration: BoxDecoration(
            border: Border(
              left: BorderSide(
                color: theme.colorScheme.outlineVariant,
                width: 3,
              ),
            ),
          ),
          padding: const EdgeInsets.only(left: 10, top: 2, bottom: 2),
          child: Text.rich(
            _inlineSpan(
              theme,
              baseStyle.copyWith(color: theme.colorScheme.onSurfaceVariant),
              spans,
            ),
          ),
        );

      case MarkdownThematicBreak():
        return const Divider(height: 1);

      case MarkdownTable(:final header, :final alignments, :final rows):
        return _buildTable(theme, baseStyle, header, alignments, rows);

      // Code blocks are handled by the caller so they can carry a stable index.
      case MarkdownCodeBlock(:final code):
        return Text(code, style: baseStyle);
    }
  }

  /// Builds a pipe table inside a horizontal scroller so a wide table scrolls
  /// rather than overflowing the transcript width.
  Widget _buildTable(
    ThemeData theme,
    TextStyle baseStyle,
    List<List<MarkdownInline>> header,
    List<MarkdownTableAlignment> alignments,
    List<List<List<MarkdownInline>>> rows,
  ) {
    final headerStyle = baseStyle.copyWith(fontWeight: FontWeight.w700);
    final columns = header.length;
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      child: Table(
        defaultColumnWidth: const IntrinsicColumnWidth(),
        border: TableBorder.all(color: theme.colorScheme.outlineVariant),
        children: [
          TableRow(
            decoration: BoxDecoration(
              color: theme.colorScheme.surfaceContainerHighest,
            ),
            children: [
              for (var c = 0; c < columns; c++)
                _tableCell(theme, headerStyle, header[c], alignments[c]),
            ],
          ),
          for (final row in rows)
            TableRow(
              children: [
                for (var c = 0; c < columns; c++)
                  _tableCell(theme, baseStyle, row[c], alignments[c]),
              ],
            ),
        ],
      ),
    );
  }

  Widget _tableCell(
    ThemeData theme,
    TextStyle style,
    List<MarkdownInline> spans,
    MarkdownTableAlignment alignment,
  ) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      child: Align(
        alignment: switch (alignment) {
          MarkdownTableAlignment.center => Alignment.center,
          MarkdownTableAlignment.right => Alignment.centerRight,
          _ => Alignment.centerLeft,
        },
        child: Text.rich(
          _inlineSpan(theme, style, spans),
          textAlign: switch (alignment) {
            MarkdownTableAlignment.center => TextAlign.center,
            MarkdownTableAlignment.right => TextAlign.right,
            _ => TextAlign.left,
          },
        ),
      ),
    );
  }

  /// Maps a heading level to a compact transcript style.
  ///
  /// Transcript text is `bodyMedium`, so headings stay at body size and carry
  /// hierarchy through weight and the 4pt-grid spacing in [_spacingBefore]
  /// instead of a font-size jump: a plan heading must not dominate its
  /// content. Level one is capped at `titleSmall` — the app's compact
  /// section-heading role — and the weight steps down per level (w700, w600,
  /// w500) so deeper levels never render larger or heavier than the level
  /// above them.
  TextStyle _headingStyle(ThemeData theme, TextStyle baseStyle, int level) {
    final style = switch (level) {
      1 => theme.textTheme.titleSmall ?? baseStyle,
      _ => baseStyle,
    };
    final weight = switch (level) {
      1 => FontWeight.w700,
      2 => FontWeight.w600,
      _ => FontWeight.w500,
    };
    return style.copyWith(fontWeight: weight);
  }

  TextSpan _inlineSpan(
    ThemeData theme,
    TextStyle baseStyle,
    List<MarkdownInline> spans,
  ) {
    return TextSpan(
      style: baseStyle,
      children: [
        for (final span in spans) _spanFor(theme, baseStyle, span),
      ],
    );
  }

  /// Builds one inline run. http(s) links become a tappable [WidgetSpan]; every
  /// other run — including the parser's visible non-web target run — is a
  /// selectable plain [TextSpan].
  InlineSpan _spanFor(
    ThemeData theme,
    TextStyle baseStyle,
    MarkdownInline span,
  ) {
    final style = _styleFor(theme, baseStyle, span);
    if (span.href != null && isTranscriptHttpUrl(span.href)) {
      final uri = Uri.tryParse(span.href!.trim());
      if (uri != null) {
        return WidgetSpan(
          alignment: PlaceholderAlignment.baseline,
          baseline: TextBaseline.alphabetic,
          child: _TranscriptLink(uri: uri, text: span.text, style: style),
        );
      }
    }
    return TextSpan(text: span.text, style: style);
  }

  TextStyle _styleFor(
    ThemeData theme,
    TextStyle baseStyle,
    MarkdownInline span,
  ) {
    var style = baseStyle;
    if (span.bold) {
      style = style.copyWith(fontWeight: FontWeight.w700);
    }
    if (span.italic) {
      style = style.copyWith(fontStyle: FontStyle.italic);
    }
    if (span.strikethrough) {
      style = style.copyWith(decoration: TextDecoration.lineThrough);
    }
    if (span.code) {
      style = style.copyWith(
        fontFamily: 'monospace',
        backgroundColor: theme.colorScheme.surfaceContainerHighest,
      );
    }
    if (span.href != null && isTranscriptHttpUrl(span.href)) {
      // Only http(s) links look like links. Local/device paths and other
      // schemes carry an href in the model but render as plain text, matching
      // the product rule that only web URLs are actionable.
      style = style.copyWith(
        color: theme.colorScheme.primary,
        decoration: TextDecoration.underline,
      );
    }
    return style;
  }
}

/// A tappable http(s) link rendered inline via a [WidgetSpan].
///
/// Uses a [GestureDetector] rather than a `TapGestureRecognizer` so the render
/// layer needs nothing beyond `package:flutter/material.dart`; the actual open
/// is delegated to [transcriptLinkOpener], which the app wires to a launcher.
class _TranscriptLink extends StatelessWidget {
  const _TranscriptLink({
    required this.uri,
    required this.text,
    required this.style,
  });

  final Uri uri;
  final String text;
  final TextStyle style;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: () => transcriptLinkOpener?.call(uri),
        child: Text(text, style: style),
      ),
    );
  }
}

/// One list row: a fixed-width marker column plus wrapped content.
class _MarkdownListItem extends StatelessWidget {
  const _MarkdownListItem({
    required this.marker,
    required this.markerStyle,
    required this.child,
  });

  final String marker;
  final TextStyle markerStyle;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 22,
            child: Text(marker, style: markerStyle),
          ),
          Expanded(child: child),
        ],
      ),
    );
  }
}
