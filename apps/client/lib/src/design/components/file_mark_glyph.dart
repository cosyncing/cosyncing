import 'dart:math' as math;

import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:flutter/material.dart';

/// The document mark — the file-kind identity glyph.
///
/// A rounded page with a folded top-right corner: the shape every desktop OS
/// uses for "file", and the deliberate counterpart to `StatusDot`'s round
/// session mark. The two must never be confusable at a glance, which is why
/// this is a silhouette and not a differently-tinted dot — a dot that merely
/// stops pulsing reads as "idle session", not as "file".
///
/// Takes resolved colors and knows no feature types, the same discipline as
/// `StatusDot`. [foldColor] is the surface the glyph is drawn on: the fold is
/// a cut-out, so it takes the parent's own color rather than a shade of
/// [color], and the caller is the only one that knows which surface that is.
class FileMarkGlyph extends StatelessWidget {
  /// Creates a document mark [height] logical pixels tall.
  const FileMarkGlyph({
    required this.color,
    required this.foldColor,
    this.height = 13,
    super.key,
  }) : assert(height > 0, 'A document mark needs a positive height.');

  /// Key for the painted mark, exposed for visual contract tests.
  static const markKey = Key('file-mark-glyph');

  /// Fill color of the page silhouette.
  final Color color;

  /// Color of the folded-corner cut-out — the surface behind the glyph.
  final Color foldColor;

  /// Height in logical pixels. Width follows from the page ratio.
  ///
  /// 13 in a pane header, 11 inside a tab, 31 in a state panel — the sizes the
  /// design calls for, all from one ratio rather than three hand-set boxes.
  final double height;

  /// The width this glyph occupies at [height], on the 11:13 page ratio.
  static double widthFor(double height) => height * 11 / 13;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      key: markKey,
      size: Size(widthFor(height), height),
      painter: _FileMarkPainter(
        color: color,
        foldColor: foldColor,
        radius: context.tokens.radiusXs,
      ),
    );
  }
}

class _FileMarkPainter extends CustomPainter {
  const _FileMarkPainter({
    required this.color,
    required this.foldColor,
    required this.radius,
  });

  final Color color;
  final Color foldColor;
  final double radius;

  @override
  void paint(Canvas canvas, Size size) {
    // The glyph is drawn inside a tab and beside text; nothing may bleed out.
    canvas.clipRect(Offset.zero & size);
    // `radiusXs` is sized for badges and would round a 9dp mark into a
    // lozenge. A quarter of the width keeps the page shape at every size.
    final corner = math.min(radius, size.width / 4);
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Offset.zero & size,
        Radius.circular(corner),
      ),
      Paint()..color = color,
    );
    // ~40% of the width reads as a fold at 9dp and stays proportionate at 26.
    // Overshooting the edges is what removes the rounded corner underneath;
    // the clip above keeps the overshoot inside the glyph's own box.
    final fold = size.width * 0.4;
    final notch = Path()
      ..moveTo(size.width - fold, -1)
      ..lineTo(size.width + 1, -1)
      ..lineTo(size.width + 1, fold)
      ..close();
    canvas.drawPath(notch, Paint()..color = foldColor);
  }

  @override
  bool shouldRepaint(_FileMarkPainter oldDelegate) =>
      oldDelegate.color != color ||
      oldDelegate.foldColor != foldColor ||
      oldDelegate.radius != radius;
}
