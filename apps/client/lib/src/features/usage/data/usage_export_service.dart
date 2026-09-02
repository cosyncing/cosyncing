import 'dart:async';
import 'dart:ui' as ui;

import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as path_util;

/// One rendered PNG, named for the theme it was captured in.
@immutable
class UsageExportFile {
  /// Creates an export file.
  const UsageExportFile({required this.name, required this.bytes});

  /// Suggested file name, including the `.png` extension.
  final String name;

  /// PNG bytes.
  final Uint8List bytes;
}

/// Where captured cards are written.
///
/// A seam, so the capture and the destination can be tested apart: a widget
/// test can prove the PNG is 1080×1920 without a file dialog, and the platform
/// implementations stay thin enough to read.
// ignore: one_member_abstracts
abstract class UsageExportSink {
  // One method today, but the two implementations differ by platform rather
  // than by behaviour, and a test substitutes a third. A top-level function
  // would have to carry the platform switch inside it.

  /// Writes both files, returning what was written, or `null` if the user
  /// cancelled.
  Future<List<String>?> write(List<UsageExportFile> files);
}

/// Desktop and mobile: one directory choice covers both files.
///
/// Two save dialogs for one button would make the dual-theme export feel like
/// two exports, which is exactly the decision the design removed from the
/// sender.
class DirectoryUsageExportSink implements UsageExportSink {
  /// Creates the sink.
  const DirectoryUsageExportSink({
    this.pickDirectory = getDirectoryPath,
    this.writeFile = _writeFile,
  });

  /// Directory-choosing boundary.
  final Future<String?> Function() pickDirectory;

  /// File-writing boundary.
  final Future<void> Function(String path, Uint8List bytes) writeFile;

  @override
  Future<List<String>?> write(List<UsageExportFile> files) async {
    final directory = await pickDirectory();
    if (directory == null) return null;
    final written = <String>[];
    for (final file in files) {
      final target = path_util.join(directory, file.name);
      await writeFile(target, file.bytes);
      written.add(file.name);
    }
    return written;
  }
}

Future<void> _writeFile(String path, Uint8List bytes) async {
  await XFile.fromData(bytes, mimeType: 'image/png').saveTo(path);
}

/// Web: the browser owns the destination, so each file is handed over in turn.
class BrowserUsageExportSink implements UsageExportSink {
  /// Creates the sink.
  const BrowserUsageExportSink();

  @override
  Future<List<String>?> write(List<UsageExportFile> files) async {
    final written = <String>[];
    for (final file in files) {
      await XFile.fromData(
        file.bytes,
        name: file.name,
        mimeType: 'image/png',
      ).saveTo('');
      written.add(file.name);
    }
    return written;
  }
}

/// The sink for this platform.
final Provider<UsageExportSink> usageExportSinkProvider =
    Provider<UsageExportSink>(
      (ref) => kIsWeb
          ? const BrowserUsageExportSink()
          : const DirectoryUsageExportSink(),
    );

/// Captures one laid-out `RepaintBoundary` as PNG bytes.
typedef UsageExportCapture = Future<Uint8List?> Function(GlobalKey boundaryKey);

/// The capture used by the share section.
///
/// A seam because rasterizing needs the real engine: a widget test drives
/// fake async, so a test that presses the export button has to substitute a
/// capture. The rasterizer itself is proven separately, under `runAsync`.
final Provider<UsageExportCapture> usageExportCaptureProvider =
    Provider<UsageExportCapture>((ref) => captureUsageExportCard);

/// Pixel ratio for a captured card: 360×640 logical becomes 1080×1920.
const double usageExportPixelRatio = 3;

/// Captures one `RepaintBoundary` as PNG bytes.
///
/// Returns `null` when the boundary has not been laid out yet, rather than
/// throwing: a card that has never been on screen has nothing to capture, and
/// that is a state the caller can report rather than a crash.
Future<Uint8List?> captureUsageExportCard(
  GlobalKey boundaryKey, {
  double pixelRatio = usageExportPixelRatio,
}) async {
  final object = boundaryKey.currentContext?.findRenderObject();
  if (object is! RenderRepaintBoundary) return null;
  final image = await object.toImage(pixelRatio: pixelRatio);
  try {
    final data = await image.toByteData(format: ui.ImageByteFormat.png);
    return data?.buffer.asUint8List();
  } finally {
    image.dispose();
  }
}
