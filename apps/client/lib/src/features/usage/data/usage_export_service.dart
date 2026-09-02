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
///
/// Handing two downloads to a browser is not the same as writing two files.
/// Chrome gates a second download from the same gesture behind a permission
/// prompt, and a page that starts them in the same tick can have the second
/// dropped without an error anyone can catch. The gap gives the browser a
/// chance to present them as two downloads rather than a burst, and the section
/// says out loud that the browser may ask — because this sink cannot find out
/// whether it did.
class BrowserUsageExportSink implements UsageExportSink {
  /// Creates the sink.
  const BrowserUsageExportSink({
    this.betweenFiles = _betweenBrowserDownloads,
    this.handOver = _handOverToBrowser,
  });

  /// Pause between handovers. Injectable so a test does not wait for it.
  final Duration betweenFiles;

  /// Handover boundary, for the same reason the directory sink has one.
  final Future<void> Function(UsageExportFile file) handOver;

  @override
  Future<List<String>?> write(List<UsageExportFile> files) async {
    final written = <String>[];
    for (final file in files) {
      if (written.isNotEmpty) await Future<void>.delayed(betweenFiles);
      await handOver(file);
      written.add(file.name);
    }
    return written;
  }
}

Future<void> _handOverToBrowser(UsageExportFile file) async {
  await XFile.fromData(
    file.bytes,
    name: file.name,
    mimeType: 'image/png',
  ).saveTo('');
}

const Duration _betweenBrowserDownloads = Duration(milliseconds: 400);

/// The sink for this platform.
final Provider<UsageExportSink> usageExportSinkProvider =
    Provider<UsageExportSink>(
      (ref) => kIsWeb
          ? const BrowserUsageExportSink()
          : const DirectoryUsageExportSink(),
    );

/// Whether this platform can write an export at all.
///
/// False on iOS and Android, and the reason is the directory picker rather than
/// anything about the card. `file_selector_ios` does not implement
/// `getDirectoryPath`, so the platform-interface default throws; the Android
/// plugin implements it but answers by converting a Storage Access Framework
/// tree URI back into a raw path, which throws for anything but the primary
/// volume and, when it does succeed, hands back a path scoped storage will not
/// let this app write — it holds no storage permission.
///
/// Left as a capability check rather than a `try` around the export, because a
/// button that always fails is worse than a button that is not there: the
/// failure looks like a bug in the report, and it is a missing platform sink.
bool usageExportSupportedOn(TargetPlatform platform) {
  if (kIsWeb) return true;
  return platform != TargetPlatform.iOS && platform != TargetPlatform.android;
}

/// Whether export is offered here. Overridable so a test can pin either answer.
final Provider<bool> usageExportSupportedProvider = Provider<bool>(
  (ref) => usageExportSupportedOn(defaultTargetPlatform),
);

/// Whether the destination is a browser. Overridable for the same reason.
final Provider<bool> usageExportIsBrowserProvider = Provider<bool>(
  (ref) => kIsWeb,
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
