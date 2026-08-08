import 'dart:io';
import 'package:path/path.dart' as p;
import 'package:uuid/uuid.dart';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'pasteboard_platform.dart';

const PasteboardPlatform pasteboard = PasteboardPlatformIO();

class PasteboardPlatformIO implements PasteboardPlatform {
  const PasteboardPlatformIO();

  static const MethodChannel _channel = MethodChannel('pasteboard');

  /// Error code every platform uses to refuse an over-bound image.
  static const _imageTooLargeCode = 'image-too-large';

  @override
  Future<List<String>> files({int? limit}) async {
    final files = await _channel.invokeMethod<List>(
      'files',
      limit == null ? null : <String, Object>{'limit': limit},
    );
    return files?.cast<String>() ?? const [];
  }

  @override
  Future<Uint8List?> boundedImage({
    required int maxBytes,
    required int maxDecodedBytes,
  }) async {
    final Object? image;
    try {
      image = await _channel.invokeMethod<Object>('image', <String, Object>{
        'maxBytes': maxBytes,
        'maxDecodedBytes': maxDecodedBytes,
      });
    } on PlatformException catch (error) {
      if (error.code == _imageTooLargeCode) {
        throw PasteboardLimitExceeded(maxBytes);
      }
      rethrow;
    }
    return _decodeImage(image);
  }

  @override
  Future<String?> get html async {
    if (Platform.isWindows || Platform.isAndroid) {
      return await _channel.invokeMethod<Object>('html') as String?;
    }
    return null;
  }

  @override
  Future<Uint8List?> get image async =>
      _decodeImage(await _channel.invokeMethod<Object>('image'));

  /// Windows answers with a temp-file path; every other platform sends bytes.
  Future<Uint8List?> _decodeImage(Object? image) async {
    if (image == null) {
      return null;
    }
    if (Platform.isMacOS ||
        Platform.isLinux ||
        Platform.isIOS ||
        Platform.isAndroid) {
      return image as Uint8List;
    } else if (Platform.isWindows) {
      final file = File(image as String);
      final bytes = await file.readAsBytes();
      await file.delete();
      return bytes;
    }
    return null;
  }

  @override
  Future<bool> writeFiles(List<String> files) async {
    try {
      await _channel.invokeMethod<Object>('writeFiles', files);
      return true;
    } catch (error, stacktrace) {
      debugPrint('$error\n$stacktrace');
      return false;
    }
  }

  @override
  Future<void> writeImage(Uint8List? image) async {
    if (image == null) {
      return;
    }
    if (Platform.isIOS || Platform.isMacOS || Platform.isAndroid) {
      await _channel.invokeMethod<void>('writeImage', image);
    } else if (Platform.isWindows) {
      final file = await File(_getTempFileName()).create();
      file.writeAsBytesSync(image);
      await _channel
          .invokeMethod<Object>('writeImage', {'fileName': file.path});
      file.delete();
    }
  }

  @override
  Future<String?> get text async {
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    return data?.text;
  }

  @override
  void writeText(String value) {
    Clipboard.setData(ClipboardData(text: value));
  }
}

String _getTempFileName() {
  final dir = Directory.systemTemp;
  String tempFileName;

  const uuid = Uuid();

  while (true) {
    tempFileName = p.join(dir.path, uuid.v1().toString());
    if (!File(tempFileName).existsSync()) {
      break;
    }
  }

  return tempFileName;
}
