/// A temporary, file-scoped media URL. Never persist it in tab metadata.
class MediaPreviewTicket {
  /// Creates a media capability returned by the broker.
  const MediaPreviewTicket({
    required this.url,
    required this.size,
    required this.mimeType,
  });

  /// URL that a native decoder can request without broker credentials.
  final Uri url;

  /// Full encoded byte length checked by the broker.
  final int size;

  /// Allowlisted media content type.
  final String mimeType;
}
