import 'dart:async';
import 'dart:math' as math;

import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

/// Shares one wave clock across a visible quota panel, without rebuilding it
/// on animation frames. Hidden views, background apps and reduced motion stop
/// the clock; individual circles repaint inside their own boundaries.
class QuotaLiquidMotion extends StatefulWidget {
  /// Creates the panel's motion scope.
  const QuotaLiquidMotion({
    required this.enabled,
    required this.child,
    super.key,
  });

  /// Whether the panel has a known, partially filled reserve to animate.
  final bool enabled;

  /// Provider readings, built independently of the wave clock.
  final Widget child;

  @override
  State<QuotaLiquidMotion> createState() => _QuotaLiquidMotionState();
}

class _QuotaLiquidMotionState extends State<QuotaLiquidMotion> {
  final _phase = ValueNotifier<double>(0);
  Timer? _timer;
  late final AppLifecycleListener _lifecycle;
  bool _motionAllowed = false;

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(onStateChange: (_) => _syncMotion());
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _motionAllowed =
        !kIsWeb &&
        !MediaQuery.disableAnimationsOf(context) &&
        TickerMode.valuesOf(context).enabled;
    _syncMotion();
  }

  @override
  void didUpdateWidget(QuotaLiquidMotion oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncMotion();
  }

  void _syncMotion() {
    final lifecycle = WidgetsBinding.instance.lifecycleState;
    final active = lifecycle == null || lifecycle == AppLifecycleState.resumed;
    if (widget.enabled && _motionAllowed && active) {
      // Native panels use a slow six-second drift. Web gauges stay static:
      // even isolated painters otherwise present the whole scene each sample.
      _timer ??= Timer.periodic(const Duration(milliseconds: 250), (_) {
        _phase.value = (_phase.value + 1 / 24) % 1;
      });
    } else {
      _timer?.cancel();
      _timer = null;
    }
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    _timer?.cancel();
    _phase.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) =>
      _QuotaWaveClock(phase: _phase, child: widget.child);
}

class _QuotaWaveClock extends InheritedWidget {
  const _QuotaWaveClock({required this.phase, required super.child});

  final ValueListenable<double> phase;

  @override
  bool updateShouldNotify(_QuotaWaveClock oldWidget) =>
      phase != oldWidget.phase;
}

/// A single quota's remaining percentage, represented by liquid area.
///
/// Each window has its own circle. Unknown, exhausted and full reserves are
/// static and distinct; motion never changes the mean remaining allowance.
class QuotaLiquidGauge extends StatelessWidget {
  /// Creates a gauge using the caller's resolved quota severity color.
  const QuotaLiquidGauge({
    required this.remaining,
    required this.color,
    super.key,
  });

  /// Remaining percentage, or null for an unreadable window.
  final double? remaining;

  /// Semantic severity color for this window.
  final Color color;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final percentage = remaining?.clamp(0, 100).toDouble();
    final phase = context
        .dependOnInheritedWidgetOfExactType<_QuotaWaveClock>()!
        .phase;
    final text = percentage == null
        ? '—'
        : NumberFormat.percentPattern(
            Localizations.localeOf(context).toString(),
          ).format(percentage / 100);
    return RepaintBoundary(
      child: SizedBox.square(
        dimension:
            48 * math.max(1, MediaQuery.textScalerOf(context).scale(14) / 14),
        child: CustomPaint(
          painter: _QuotaLiquidPainter(
            remaining: percentage,
            phase: phase,
            background: tokens.surface2,
            fill: Color.lerp(tokens.surface2, color, .28)!,
            outline: percentage == 0 ? color : tokens.separator,
          ),
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(4),
              child: FittedBox(
                fit: BoxFit.scaleDown,
                child: Text(
                  text,
                  style: Theme.of(context).textTheme.labelLarge?.copyWith(
                    color: tokens.textPrimary,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _QuotaLiquidPainter extends CustomPainter {
  _QuotaLiquidPainter({
    required this.remaining,
    required this.phase,
    required this.background,
    required this.fill,
    required this.outline,
  }) : _level = _surfaceLevel(remaining),
       super(
         repaint: remaining != null && remaining > 0 && remaining < 100
             ? phase
             : null,
       );

  final double? remaining;
  final ValueListenable<double> phase;
  final Color background;
  final Color fill;
  final Color outline;
  final double _level;

  // Invert circular-segment area once per reading, outside the paint loop:
  // 21% remaining fills 21% of the circle, rather than 21% of its diameter.
  static double _surfaceLevel(double? remaining) {
    if (remaining == null || remaining <= 0) return 1;
    if (remaining >= 100) return -1;
    var low = -1.0;
    var high = 1.0;
    for (var step = 0; step < 24; step++) {
      final mid = (low + high) / 2;
      final area = (math.acos(mid) - mid * math.sqrt(1 - mid * mid)) / math.pi;
      if (area > remaining / 100) {
        low = mid;
      } else {
        high = mid;
      }
    }
    return (low + high) / 2;
  }

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final radius = size.shortestSide / 2 - 1;
    final circle = Rect.fromCircle(center: center, radius: radius);
    canvas.drawCircle(center, radius, Paint()..color = background);
    if (remaining != null && remaining! > 0) {
      canvas
        ..save()
        ..clipPath(Path()..addOval(circle));
      if (remaining! >= 100) {
        canvas.drawRect(circle, Paint()..color = fill);
      } else {
        final surface = center.dy + radius * _level;
        final amplitude = math.min(2, radius * (1 - _level.abs()) / 2);
        final wave = Path()..moveTo(0, surface);
        for (var x = 0.0; x <= size.width; x += 2) {
          wave.lineTo(
            x,
            surface +
                math.sin(
                      x / size.width * math.pi * 2 + phase.value * math.pi * 2,
                    ) *
                    amplitude,
          );
        }
        wave
          ..lineTo(size.width, size.height)
          ..lineTo(0, size.height)
          ..close();
        canvas.drawPath(wave, Paint()..color = fill);
      }
      canvas.restore();
    }
    canvas.drawCircle(
      center,
      radius,
      Paint()
        ..color = outline
        ..style = PaintingStyle.stroke
        ..strokeWidth = 1,
    );
  }

  @override
  bool shouldRepaint(_QuotaLiquidPainter oldDelegate) =>
      remaining != oldDelegate.remaining ||
      phase != oldDelegate.phase ||
      background != oldDelegate.background ||
      fill != oldDelegate.fill ||
      outline != oldDelegate.outline;
}
