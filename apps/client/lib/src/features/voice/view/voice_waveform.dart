import 'package:flutter/material.dart';

/// Real waveform driven by normalized sound-level samples (0.0..1.0).
///
/// Draws vertical bars whose height is proportional to each sample. When the
/// sample list is empty, nothing is painted - the caller shows a static
/// listening indicator instead. Fixed height; no layout shifts.
///
/// The waveform is decorative for accessibility; a textual `Listening` status
/// is shown alongside it by the panel.
///
/// Governing doc: `docs/architecture/client-ui.md`
/// (section "Real waveform").
class VoiceWaveform extends StatelessWidget {
  /// Creates a waveform from normalized samples.
  const VoiceWaveform({
    required this.samples,
    required this.color,
    super.key,
  });

  /// Normalized sound-level samples in `0.0..1.0`.
  final List<double> samples;

  /// Bar color.
  final Color color;

  /// Fixed waveform height.
  static const double height = 32;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: height,
      child: CustomPaint(
        painter: _WaveformPainter(samples: samples, color: color),
        size: const Size(double.infinity, height),
      ),
    );
  }
}

class _WaveformPainter extends CustomPainter {
  _WaveformPainter({required this.samples, required this.color});

  final List<double> samples;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    if (samples.isEmpty) return;
    final paint = Paint()..color = color;
    final barSpace = size.width / samples.length;
    final barWidth = barSpace * 0.6;
    final centerY = size.height / 2;

    for (var i = 0; i < samples.length; i++) {
      final sample = samples[i].clamp(0.0, 1.0);
      final barHeight = (sample * size.height).clamp(2.0, size.height);
      final rect = RRect.fromRectAndRadius(
        Rect.fromCenter(
          center: Offset(i * barSpace + barSpace / 2, centerY),
          width: barWidth,
          height: barHeight,
        ),
        Radius.circular(barWidth / 2),
      );
      canvas.drawRRect(rect, paint);
    }
  }

  @override
  bool shouldRepaint(_WaveformPainter oldDelegate) =>
      samples != oldDelegate.samples || color != oldDelegate.color;
}
