import 'dart:math' as math;

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_telemetry.dart';
import 'package:flutter/material.dart';

/// How a [SessionContextMeter] presents its reading.
enum SessionContextMeterStyle {
  /// Icon-sized hollow ring that fills clockwise as the window is consumed.
  ///
  /// Carries no text, so it survives the 420dp collapse where labels cannot.
  ring,

  /// `258k / 973k` in tabular figures, for rows with width to spare.
  verbose,
}

/// Model context-window usage for one session.
///
/// Self-contained and layout-agnostic: it renders only itself at its intrinsic
/// size and makes no assumption about what surrounds it, so it can ride a
/// composer row, a top strip, or a status card unchanged.
///
/// Renders nothing at all unless the broker reported a real used/max pair. A
/// missing meter is correct; an invented one is not — see the adapter note in
/// `session_telemetry.dart` on which agents supply this reading.
class SessionContextMeter extends StatelessWidget {
  /// Creates a context meter for [telemetry].
  const SessionContextMeter({
    required this.telemetry,
    this.style = SessionContextMeterStyle.ring,
    super.key,
  });

  /// Latest telemetry snapshot for the session.
  final SessionTelemetry telemetry;

  /// Which presentation to render.
  final SessionContextMeterStyle style;

  /// Base ring diameter in logical pixels before UI scale is applied.
  ///
  /// Matches `bodyMedium`'s 14sp so the gauge never out-weighs the text beside
  /// it, per the composer control-row sizing rule.
  static const double baseDiameter = 14;

  @override
  Widget build(BuildContext context) {
    final percent = telemetry.contextPercent;
    if (percent == null) return const SizedBox.shrink();

    final theme = Theme.of(context);
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final critical = telemetry.isContextCritical;
    final color = critical ? tokens.statusError : tokens.textSecondary;

    final used = telemetry.contextUsedTokens;
    final max = telemetry.contextMaxTokens;
    final tooltip = used != null && max != null
        ? l10n.sessionContextMeterTooltipExact(
            _formatThousands(used),
            _formatThousands(max),
            percent.round(),
          )
        : l10n.sessionContextMeterTooltip(percent.round());

    return Tooltip(
      message: tooltip,
      child: switch (style) {
        SessionContextMeterStyle.ring => _buildRing(context, percent, color),
        SessionContextMeterStyle.verbose => _buildVerbose(
          theme,
          l10n,
          percent,
          color,
          used,
          max,
        ),
      },
    );
  }

  Widget _buildRing(BuildContext context, double percent, Color color) {
    // Scaling by the ambient TextScaler is what makes the gauge grow with
    // Ctrl+/-; a fixed size would shrink against text at larger UI scales.
    final diameter = MediaQuery.textScalerOf(context).scale(baseDiameter);
    return CustomPaint(
      key: const Key('session-context-meter-ring'),
      size: Size.square(diameter),
      painter: _ContextRingPainter(
        fraction: percent / 100,
        color: color,
        trackColor: context.tokens.separator,
        strokeWidth: math.max(1.5, diameter / 7),
      ),
    );
  }

  Widget _buildVerbose(
    ThemeData theme,
    AppLocalizations l10n,
    double percent,
    Color color,
    int? used,
    int? max,
  ) {
    final label = used != null && max != null
        ? '${_formatThousands(used)} / ${_formatThousands(max)}'
        : '${percent.round()}%';
    return Text(
      label,
      key: const Key('session-context-meter-verbose'),
      style: theme.textTheme.labelMedium?.copyWith(
        color: color,
        fontFeatures: const [FontFeature.tabularFigures()],
      ),
    );
  }
}

/// Draws the hollow gauge: a full faint track with an arc sweeping clockwise
/// from twelve o'clock over the consumed share.
class _ContextRingPainter extends CustomPainter {
  const _ContextRingPainter({
    required this.fraction,
    required this.color,
    required this.trackColor,
    required this.strokeWidth,
  });

  final double fraction;
  final Color color;
  final Color trackColor;
  final double strokeWidth;

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Rect.fromLTWH(
      strokeWidth / 2,
      strokeWidth / 2,
      size.width - strokeWidth,
      size.height - strokeWidth,
    );
    final track = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..color = trackColor;
    canvas.drawArc(rect, 0, math.pi * 2, false, track);

    final swept = fraction.clamp(0.0, 1.0);
    if (swept <= 0) return;
    final arc = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = strokeWidth
      ..strokeCap = StrokeCap.round
      ..color = color;
    canvas.drawArc(rect, -math.pi / 2, math.pi * 2 * swept, false, arc);
  }

  @override
  bool shouldRepaint(_ContextRingPainter old) =>
      old.fraction != fraction ||
      old.color != color ||
      old.trackColor != trackColor ||
      old.strokeWidth != strokeWidth;
}

/// Formats a token count in whole thousands (`258400` -> `258k`).
///
/// Context windows are quoted in `k` industry-wide, and whole thousands keep
/// both operands short enough to sit in one control row.
String _formatThousands(int value) {
  if (value < 1000) return '$value';
  return '${(value / 1000).round()}k';
}
