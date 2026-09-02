import 'dart:math' as math;

import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_renderers.dart';
import 'package:flutter/material.dart';

/// The monospace style every line-oriented renderer shares.
///
/// Fixed at 12pt with a 1.5 line height rather than inherited, because the
/// gutter, the item extent and the measured content width all have to agree
/// with it exactly.
TextStyle fileSourceCodeStyle(BuildContext context) {
  final theme = Theme.of(context);
  return (theme.textTheme.bodySmall ?? const TextStyle(fontSize: 12)).copyWith(
    fontFamily: 'monospace',
    height: 1.5,
    fontSize: 12,
  );
}

/// The fixed row height for one unwrapped line.
double fileSourceLineExtent(BuildContext context) {
  final style = fileSourceCodeStyle(context);
  final scaled = MediaQuery.textScalerOf(context).scale(style.fontSize!);
  return (scaled * 1.5).ceilToDouble();
}

/// Width of the absolute line-number gutter.
const double fileSourceGutterWidth = 48;

/// Width of the widest of [lines] as they will actually paint.
///
/// The character-count estimate — `length × advance` — is exact for ASCII in a
/// monospace face and wrong by roughly 2x for anything the font falls back on:
/// CJK, emoji. That is not cosmetic. Each line is a `maxLines: 1,
/// softWrap: false` `Text` inside a box of exactly this width, and the
/// horizontal scroll extent is this width too, so an underestimate clips the
/// tail of the line and no amount of scrolling brings it back. One Chinese
/// comment in a source file is enough to lose the end of its longest line.
///
/// Still not 20k `TextPainter` layouts: [measure] is called only for lines
/// carrying a code unit outside ASCII, and the estimate stands for the rest.
/// A file with no wide glyph measures nothing at all.
///
/// [measure] is a parameter rather than a `TextPainter` inside this function
/// for one reason: `flutter_test` runs on a font where every glyph has the
/// same advance, CJK included, so a test that paints cannot tell this rule
/// from the estimate it replaced. Passing the measurement in lets the rule —
/// and which lines reach it — be tested on any font.
double fileSourceContentWidth({
  required List<String> lines,
  required double advance,
  required double Function(String line) measure,
}) {
  var widest = 0.0;
  for (final line in lines) {
    if (!_needsMeasuring(line)) {
      final estimated = line.length * advance;
      if (estimated > widest) widest = estimated;
      continue;
    }
    final measured = measure(line);
    if (measured > widest) widest = measured;
  }
  return widest;
}

/// Whether [line] holds a glyph the monospace advance cannot stand in for.
///
/// Plain ASCII is exact in a monospace face. Everything else — a wide CJK
/// glyph, an emoji, a combining mark that takes no width at all — comes from a
/// fallback font whose advance is its own business.
bool _needsMeasuring(String line) {
  for (final unit in line.codeUnits) {
    if (unit > 0x7f) return true;
  }
  return false;
}

/// Styles one line of source.
///
/// Returning null renders the line as one plain run — which is what the plain
/// and log renderers do, and what a code renderer falls back to when the
/// highlighter declines.
typedef FileSourceSpanBuilder =
    List<InlineSpan>? Function(int index, TextStyle base);

/// The host's line body: absolute gutter, one horizontal axis, optional wrap.
///
/// Shared rather than per-renderer because five behaviours have to be identical
/// across renderers or the difference is a visible defect — the pinned gutter,
/// the single horizontal axis, wrap, the anchor reveal and scroll restore. A
/// renderer supplies only how a line is styled.
class FileSourceBody extends StatelessWidget {
  /// Builds the body for [lines].
  const FileSourceBody({
    required this.lines,
    required this.surface,
    required this.tokens,
    super.key,
    this.anchorLine,
    this.spanBuilder,
  });

  /// The file's lines, already split.
  final List<String> lines;

  /// The host's controllers and wrap state.
  final FileSourceSurface surface;

  /// Resolved design tokens.
  final AppTokens tokens;

  /// 1-based line the mention carried, when the broker delivered it.
  final int? anchorLine;

  /// Styles one line, or null for plain text throughout.
  final FileSourceSpanBuilder? spanBuilder;

  Widget _line(BuildContext context, int index, TextStyle style, bool wrap) {
    final spans = spanBuilder?.call(index, style);
    if (spans == null) {
      return Text(
        lines[index],
        style: style,
        softWrap: wrap,
        maxLines: wrap ? null : 1,
      );
    }
    return Text.rich(
      TextSpan(style: style, children: spans),
      softWrap: wrap,
      maxLines: wrap ? null : 1,
    );
  }

  @override
  Widget build(BuildContext context) {
    final style = fileSourceCodeStyle(context);
    final extent = fileSourceLineExtent(context);
    final anchor = anchorLine;

    // Wrapped mode has no horizontal axis to pin a gutter against, and rows
    // stop being uniform, so it is a different layout rather than a flag on
    // this one: one list, gutter top-aligned beside its wrapped block.
    if (surface.wrap) {
      return SelectionArea(
        child: ListView.builder(
          key: const Key('file-viewer-lines'),
          controller: surface.vertical,
          padding: const EdgeInsets.only(top: 8, bottom: 16),
          itemCount: lines.length,
          itemBuilder: (context, index) => Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Non-wrap keeps the gutter outside the `SelectionArea` as a
              // sibling; wrapped rows cannot, because the number has to sit
              // beside its own wrapped block. Without this the drag that
              // copies two wrapped lines also copies the two line numbers
              // between them, and the pane's rule is that a drag copies
              // source and not chrome.
              SelectionContainer.disabled(
                child: FileSourceGutterCell(
                  number: index + 1,
                  anchored: index + 1 == anchor,
                  tokens: tokens,
                  style: style,
                  height: extent,
                ),
              ),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(right: 16),
                  child: _line(context, index, style, true),
                ),
              ),
            ],
          ),
        ),
      );
    }

    final contentWidth = _contentWidth(context, style) + 16;

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Pinned: outside the horizontal viewport entirely, so it cannot
        // scroll sideways. It follows the body vertically through the host's
        // gutter controller.
        SizedBox(
          width: fileSourceGutterWidth,
          child: ListView.builder(
            key: const Key('file-viewer-gutter'),
            controller: surface.gutter,
            physics: const NeverScrollableScrollPhysics(),
            itemExtent: extent,
            padding: const EdgeInsets.only(top: 8, bottom: 16),
            itemCount: lines.length,
            itemBuilder: (context, index) => FileSourceGutterCell(
              number: index + 1,
              anchored: index + 1 == anchor,
              tokens: tokens,
              style: style,
              height: extent,
            ),
          ),
        ),
        Expanded(
          child: SelectionArea(
            child: Scrollbar(
              controller: surface.horizontal,
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                controller: surface.horizontal,
                child: SizedBox(
                  key: const Key('file-viewer-content'),
                  width: math.max(contentWidth, 1),
                  child: ListView.builder(
                    key: const Key('file-viewer-lines'),
                    controller: surface.vertical,
                    itemExtent: extent,
                    padding: const EdgeInsets.only(top: 8, bottom: 16),
                    itemCount: lines.length,
                    itemBuilder: (context, index) => Align(
                      alignment: Alignment.centerLeft,
                      child: _line(context, index, style, false),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  double _contentWidth(BuildContext context, TextStyle style) {
    final painter = TextPainter(
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
      maxLines: 1,
    );
    final width = fileSourceContentWidth(
      lines: lines,
      advance: _monospaceAdvance(context, style),
      measure: (line) {
        painter
          ..text = TextSpan(text: line, style: style)
          ..layout();
        return painter.width;
      },
    );
    painter.dispose();
    return width;
  }

  double _monospaceAdvance(BuildContext context, TextStyle style) {
    final painter = TextPainter(
      text: TextSpan(text: '0', style: style),
      textDirection: Directionality.of(context),
      textScaler: MediaQuery.textScalerOf(context),
    )..layout();
    final width = painter.width;
    painter.dispose();
    return width;
  }
}

/// One absolute line number.
///
/// The anchor reveal lives entirely here: an `accent` number and a 2dp accent
/// edge. There is deliberately no row wash — `accentSurface` cannot sit behind
/// highlighted code without dropping syntax tokens under the 4.5:1 bar the
/// theme sweep enforces (`accent_surface_token_test.dart` carries the numbers).
class FileSourceGutterCell extends StatelessWidget {
  /// Draws the number for one line.
  const FileSourceGutterCell({
    required this.number,
    required this.anchored,
    required this.tokens,
    required this.style,
    required this.height,
    super.key,
  });

  /// 1-based absolute line number.
  final int number;

  /// Whether this line is the one the mention carried.
  final bool anchored;

  /// Resolved design tokens.
  final AppTokens tokens;

  /// The shared monospace style.
  final TextStyle style;

  /// Row height, matching the body's item extent.
  final double height;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: fileSourceGutterWidth,
      height: height,
      child: Row(
        children: [
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(right: 12),
              child: Align(
                alignment: Alignment.centerRight,
                child: Text(
                  '$number',
                  key: anchored ? const Key('file-viewer-anchor-number') : null,
                  maxLines: 1,
                  style: style.copyWith(
                    color: anchored ? tokens.accent : tokens.textTertiary,
                    fontWeight: anchored ? FontWeight.w600 : FontWeight.normal,
                  ),
                ),
              ),
            ),
          ),
          Container(
            key: anchored ? const Key('file-viewer-anchor-edge') : null,
            width: 2,
            color: anchored ? tokens.accent : Colors.transparent,
          ),
        ],
      ),
    );
  }
}
