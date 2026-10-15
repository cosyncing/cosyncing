// The device camera, as the `mobile_scanner` plugin sees it.
//
// Installed as `MobileScannerPlatform.instance`, so the app's real scanner
// route and `MobileScanner` widget run; the test decides what the camera
// "sees" with [FakeCamera.detect].
import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

/// A camera that reports the barcodes the test shows it.
class FakeCamera extends MobileScannerPlatform {
  final _barcodes = StreamController<BarcodeCapture?>.broadcast();

  /// Times the scanner started the camera.
  int starts = 0;

  /// Whether the camera is currently running.
  bool running = false;

  /// The camera sees a QR code carrying [rawValue].
  void detect(String rawValue) => _barcodes.add(
    BarcodeCapture(barcodes: [Barcode(rawValue: rawValue)]),
  );

  @override
  Stream<BarcodeCapture?> get barcodesStream => _barcodes.stream;

  @override
  Stream<TorchState> get torchStateStream => const Stream.empty();

  @override
  Stream<double> get zoomScaleStateStream => const Stream.empty();

  @override
  Widget buildCameraView() =>
      const SizedBox.expand(key: Key('fake-camera-view'));

  @override
  Future<MobileScannerViewAttributes> start(StartOptions startOptions) async {
    starts += 1;
    running = true;
    return const MobileScannerViewAttributes(
      cameraDirection: CameraFacing.back,
      currentTorchMode: TorchState.unavailable,
      size: Size(640, 480),
      numberOfCameras: 1,
    );
  }

  @override
  Future<void> stop() async => running = false;

  @override
  Future<void> pause() async => running = false;

  @override
  Future<void> dispose() async => running = false;

  @override
  Future<void> updateScanWindow(Rect? window) async {}

  @override
  Future<void> resetZoomScale() async {}

  @override
  Future<void> setZoomScale(double zoomScale) async {}

  @override
  Future<void> setFocusPoint(Offset position) async {}

  @override
  Future<void> toggleTorch() async {}
}
