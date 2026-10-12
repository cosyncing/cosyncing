/// Compact token counts using decimal k / M / B units.
String formatTokenCount(int tokens) {
  const units = [(1000000000, 'B'), (1000000, 'M'), (1000, 'k')];
  String render(double value, String suffix) {
    final count = value.toStringAsFixed(1).replaceFirst(RegExp(r'\.0$'), '');
    return '$count$suffix';
  }

  for (var index = 0; index < units.length; index++) {
    final (divisor, suffix) = units[index];
    if (tokens.abs() < divisor) continue;
    final value = tokens / divisor;
    if (value.abs().toStringAsFixed(1) == '1000.0' && index > 0) {
      final (larger, unit) = units[index - 1];
      return render(tokens / larger, unit);
    }
    return render(value, suffix);
  }
  return '$tokens';
}
