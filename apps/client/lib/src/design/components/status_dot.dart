import 'package:flutter/material.dart';

/// A small circular status indicator dot.
///
/// Renders a filled circle in [color], optionally wrapped in a contrasting
/// [ringColor] ring to draw attention (for example a session that needs
/// input). The widget reads no tokens itself — callers pass a resolved
/// semantic color such as `context.tokens.toolColor(tool)` or
/// `context.tokens.statusNeedsInput`, keeping the design layer free of feature
/// types.
class StatusDot extends StatelessWidget {
  /// Creates a status dot of [size] logical pixels filled with [color].
  const StatusDot({
    required this.color,
    this.ringColor,
    this.size = 12,
    super.key,
  });

  /// Fill color of the dot.
  final Color color;

  /// When non-null, draws a 2px ring in this color around the dot.
  final Color? ringColor;

  /// Diameter of the dot in logical pixels.
  final double size;

  @override
  Widget build(BuildContext context) {
    final ring = ringColor;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: color,
        shape: BoxShape.circle,
        border: ring != null ? Border.all(color: ring, width: 2) : null,
      ),
    );
  }
}
