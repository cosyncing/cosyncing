import 'package:flutter/material.dart';

/// A small circular status indicator with optional motion and attention ring.
///
/// [pulse] softly varies only the fill opacity. [ringColor] draws a full outer
/// ring with a two-pixel [ringGapColor] separation instead of thickening the
/// fill. Callers resolve all semantic colors before entering the design kit.
class StatusDot extends StatefulWidget {
  /// Creates a status dot of [size] logical pixels filled with [color].
  const StatusDot({
    required this.color,
    this.ringColor,
    this.ringGapColor,
    this.pulse = false,
    this.size = 12,
    super.key,
  }) : assert(
         ringColor == null || ringGapColor != null,
         'A ring gap color is required when a status ring is drawn.',
       );

  /// Key for the filled inner dot, exposed for visual contract tests.
  static const fillKey = Key('status-dot-fill');

  /// Key for the optional outer ring, exposed for visual contract tests.
  static const ringKey = Key('status-dot-ring');

  /// Fill color of the dot.
  final Color color;

  /// When non-null, draws a two-pixel outer ring in this color.
  final Color? ringColor;

  /// Surface color used for the two-pixel gap inside [ringColor].
  final Color? ringGapColor;

  /// Whether the fill softly pulses while motion and tickers are enabled.
  final bool pulse;

  /// Diameter of the ordinary, unringed dot in logical pixels.
  final double size;

  @override
  State<StatusDot> createState() => _StatusDotState();
}

class _StatusDotState extends State<StatusDot>
    with SingleTickerProviderStateMixin {
  AnimationController? _controller;
  Animation<double>? _opacity;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _syncAnimation();
  }

  @override
  void didUpdateWidget(StatusDot oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.pulse != widget.pulse) _syncAnimation();
  }

  void _syncAnimation() {
    final reduceMotion =
        MediaQuery.maybeOf(context)?.disableAnimations ?? false;
    final shouldAnimate =
        widget.pulse && !reduceMotion && TickerMode.valuesOf(context).enabled;
    if (!shouldAnimate) {
      _controller?.dispose();
      _controller = null;
      _opacity = null;
      return;
    }
    if (_controller != null) return;
    final controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1600),
    );
    _controller = controller;
    _opacity = TweenSequence<double>([
      TweenSequenceItem(
        tween: Tween<double>(begin: 1, end: .35).chain(
          CurveTween(curve: Curves.easeInOut),
        ),
        weight: 1,
      ),
      TweenSequenceItem(
        tween: Tween<double>(begin: .35, end: 1).chain(
          CurveTween(curve: Curves.easeInOut),
        ),
        weight: 1,
      ),
    ]).animate(controller);
    controller.repeat();
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final fill = Container(
      key: StatusDot.fillKey,
      width: widget.ringColor == null ? widget.size : widget.size - 4,
      height: widget.ringColor == null ? widget.size : widget.size - 4,
      decoration: BoxDecoration(
        color: widget.color,
        shape: BoxShape.circle,
      ),
    );
    final opacity = _opacity;
    final animatedFill = opacity == null
        ? fill
        : FadeTransition(opacity: opacity, child: fill);
    final ring = widget.ringColor;
    if (ring == null) return animatedFill;

    return Container(
      key: StatusDot.ringKey,
      width: widget.size + 4,
      height: widget.size + 4,
      padding: const EdgeInsets.all(2),
      decoration: BoxDecoration(color: ring, shape: BoxShape.circle),
      child: Container(
        padding: const EdgeInsets.all(2),
        decoration: BoxDecoration(
          color: widget.ringGapColor,
          shape: BoxShape.circle,
        ),
        child: animatedFill,
      ),
    );
  }
}
