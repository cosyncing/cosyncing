import 'dart:typed_data';

/// Thrown when the platform refuses a read because it exceeds a caller bound.
///
/// Fork addition. The refusal happens in native code, before the payload is
/// encoded or sent over the method channel, so the Dart isolate never
/// allocates it.
class PasteboardLimitExceeded implements Exception {
  const PasteboardLimitExceeded(this.limit);

  /// The bound the caller supplied, in bytes.
  final int limit;

  @override
  String toString() => 'PasteboardLimitExceeded($limit)';
}

abstract class PasteboardPlatform {
  Future<Uint8List?> get image;

  /// Reads a clipboard image under two separate bounds.
  ///
  /// Fork addition. [maxBytes] bounds the *result*: the bytes this returns
  /// never exceed it. [maxDecodedBytes] bounds what native code is willing to
  /// allocate on the way there, compared against the decoded pixel size before
  /// anything is encoded. Throws [PasteboardLimitExceeded] for either.
  ///
  /// They are separate because they are not the same quantity. macOS and Linux
  /// return PNG, whose size cannot be derived from the dimensions — a 20 MP
  /// screenshot can encode to a few MB — so a decoded size compared against a
  /// file-size budget would refuse ordinary images. Give [maxDecodedBytes] a
  /// value no real image reaches and let the encoded length decide. Windows is
  /// the exception: it returns an uncompressed bitmap, so its result really is
  /// the decoded size and both bounds apply at once.
  Future<Uint8List?> boundedImage({
    required int maxBytes,
    required int maxDecodedBytes,
  });

  Future<String?> get html;

  Future<void> writeImage(Uint8List? image);

  /// Reads clipboard file paths, at most [limit] of them when given.
  ///
  /// Fork addition. Native code stops after [limit] entries, so a clipboard
  /// holding thousands of paths costs a bounded list rather than all of them.
  /// A result of exactly [limit] means the clipboard held at least that many.
  Future<List<String>> files({int? limit});

  Future<bool> writeFiles(List<String> files);

  Future<String?> get text;

  void writeText(String value);
}
