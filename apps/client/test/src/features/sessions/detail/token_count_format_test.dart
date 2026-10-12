import 'package:cosyncing_client/src/features/sessions/detail/token_count_format.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('token counts stay readable across decimal unit boundaries', () {
    for (final (value, label) in [
      (0, '0'),
      (999, '999'),
      (1000, '1k'),
      (12345, '12.3k'),
      (999999, '1M'),
      (1234567, '1.2M'),
      (999999999, '1B'),
      (2345678901, '2.3B'),
    ]) {
      expect(formatTokenCount(value), label);
    }
  });
}
