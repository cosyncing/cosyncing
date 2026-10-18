import 'dart:typed_data';

/// Built-in passive media kinds.
enum FileMediaKind {
  /// Raster image, including animated GIF.
  image,

  /// Portable document.
  pdf,

  /// Video decoded by the platform.
  video,
}

/// Encoded size ceiling, independent of the small text-preview cap.
int fileMediaByteLimit(FileMediaKind kind) => switch (kind) {
  FileMediaKind.image => 32 * 1024 * 1024,
  FileMediaKind.pdf => 128 * 1024 * 1024,
  FileMediaKind.video => 2 * 1024 * 1024 * 1024,
};

/// Restricts renderers to known media; other documents keep their own paths.
FileMediaKind? fileMediaKind(String path, [String? mimeType]) {
  final extension = path.split('.').last.toLowerCase();
  if (const {'png', 'jpg', 'jpeg', 'webp', 'gif'}.contains(extension)) {
    return FileMediaKind.image;
  }
  if (extension == 'pdf') return FileMediaKind.pdf;
  if (const {'mp4', 'm4v', 'mov', 'webm'}.contains(extension)) {
    return FileMediaKind.video;
  }
  return null;
}

/// Loads a selected file without keeping bytes or players in session state.
class FileMediaPreview {
  /// The host owns all I/O and releases the source when the view disappears.
  const FileMediaPreview({required this.kind, required this.load});

  /// Renderer to open.
  final FileMediaKind kind;

  /// Invoked for a visible preview, never while listing files or sessions.
  final Future<FileMediaSource> Function() load;
}

/// One visible preview's resource, revoked when disposed.
class FileMediaSource {
  /// Network media is ranged; inline media carries already-delivered bytes.
  const FileMediaSource({this.uri, this.bytes, this.release});

  /// Scoped media URL, never a URL containing the broker credential.
  final Uri? uri;

  /// Inline artifact bytes.
  final Uint8List? bytes;

  /// Releases the broker capability without delaying navigation.
  final void Function()? release;
}
