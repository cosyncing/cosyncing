import 'dart:io';

import 'package:integration_test/integration_test_driver_extended.dart';

/// Driver for on-device screenshot capture.
///
/// Run with:
///   flutter drive \
///     --driver=test_driver/integration_test.dart \
///     --target=integration_test/screenshot_test.dart \
///     -d DEVICE_ID
///
/// Each `binding.takeScreenshot(name)` in the target arrives here as PNG bytes
/// and is written to `build/screenshots/<name>.png` on the host runner, which CI
/// then copies into the dated `ci-screens` directory.
Future<void> main() async {
  await integrationDriver(
    onScreenshot:
        (
          String name,
          List<int> bytes, [
          Map<String, Object?>? args,
        ]) async {
          final dir = Directory('build/screenshots');
          if (!dir.existsSync()) {
            dir.createSync(recursive: true);
          }
          File('${dir.path}/$name.png').writeAsBytesSync(bytes);
          return true;
        },
  );
}
