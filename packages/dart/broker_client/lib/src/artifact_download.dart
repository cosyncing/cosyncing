/// Typed artifact download result for remote or inline artifact retrieval.
class ArtifactDownload {
  /// Creates an [ArtifactDownload].
  const ArtifactDownload({
    required this.bytes,
    this.contentType,
    this.contentLength,
    this.artifactKey,
    this.contentHash,
    this.sourceUrl,
    this.statusCode = 200,
    this.etag,
    this.lastModified,
    this.acceptRanges,
    this.contentRange,
  });

  /// Raw artifact bytes.
  final List<int> bytes;

  /// Response `content-type` header if available.
  final String? contentType;

  /// Parsed `content-length` header if available.
  final int? contentLength;

  /// Artifact key extracted from response metadata if available.
  final String? artifactKey;

  /// Content hash extracted from response metadata if available.
  final String? contentHash;

  /// Final source URL used for this fetch.
  final String? sourceUrl;

  /// HTTP response status (`200`, `206`, or `416` for ranged downloads).
  final int statusCode;

  /// Strong representation validator, when advertised.
  final String? etag;

  /// HTTP-date representation validator, when advertised.
  final String? lastModified;

  /// Raw `Accept-Ranges` response value.
  final String? acceptRanges;

  /// Raw `Content-Range` response value.
  final String? contentRange;
}
