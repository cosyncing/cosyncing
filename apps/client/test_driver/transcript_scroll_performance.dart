import 'dart:convert';
import 'dart:io';

import 'package:integration_test/integration_test_driver.dart';

/// Host side of `integration_test/transcript_scroll_performance_test.dart`.
///
/// Writes the report the app side collected to the path in
/// `TRANSCRIPT_SCROLL_OUT` (default `build/transcript_scroll.json`).
Future<void> main() => integrationDriver(
  timeout: const Duration(minutes: 40),
  writeResponseOnFailure: true,
  responseDataCallback: (data) async {
    final path =
        Platform.environment['TRANSCRIPT_SCROLL_OUT'] ??
        'build/transcript_scroll.json';
    File(path)
      ..createSync(recursive: true)
      ..writeAsStringSync(const JsonEncoder.withIndent('  ').convert(data));
  },
);
