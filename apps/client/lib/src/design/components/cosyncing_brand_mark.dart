import 'package:flutter/material.dart';

/// The original two-tone brand artwork, reproduced from the two paths in the
/// brand master SVG. Brand ink is intrinsic artwork, independent of UI themes.
class CosyncingBrandMark extends StatelessWidget {
  /// Creates an original mark at [size] logical pixels.
  const CosyncingBrandMark({this.size = 28, super.key});

  /// Square artwork bounds.
  final double size;

  @override
  Widget build(BuildContext context) => Semantics(
    image: true,
    label: 'Cosyncing',
    child: CustomPaint(
      size: Size.square(size),
      painter: _BrandPainter(Theme.of(context).brightness),
    ),
  );
}

class _BrandPainter extends CustomPainter {
  const _BrandPainter(this.brightness);
  final Brightness brightness;

  @override
  void paint(Canvas canvas, Size size) {
    canvas
      ..save()
      ..scale(size.width / 100, size.height / 100);
    final lower = Path()
      ..moveTo(86, 40)
      ..lineTo(86, 74)
      ..arcToPoint(const Offset(74, 86), radius: const Radius.circular(18))
      ..lineTo(40, 86)
      ..lineTo(40, 74)
      ..lineTo(66, 74)
      ..arcToPoint(
        const Offset(74, 66),
        radius: const Radius.circular(8),
        clockwise: false,
      )
      ..lineTo(74, 40)
      ..close();
    final upper = Path()
      ..moveTo(14, 60)
      ..lineTo(14, 26)
      ..arcToPoint(const Offset(26, 14), radius: const Radius.circular(18))
      ..lineTo(60, 14)
      ..lineTo(60, 26)
      ..lineTo(34, 26)
      ..arcToPoint(
        const Offset(26, 34),
        radius: const Radius.circular(8),
        clockwise: false,
      )
      ..lineTo(26, 60)
      ..close();
    final dark = brightness == Brightness.dark;
    canvas
      ..drawPath(
        lower,
        Paint()
          ..color = dark ? const Color(0xFF2DD4BF) : const Color(0xFF0B0E14),
      )
      ..drawPath(
        upper,
        Paint()
          ..color = dark ? const Color(0xFFF2F5F4) : const Color(0xFF0F766E),
      )
      ..restore();
  }

  @override
  bool shouldRepaint(_BrandPainter oldDelegate) =>
      oldDelegate.brightness != brightness;
}
