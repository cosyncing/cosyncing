/// Thrown by `BrokerClient.fetchArtifactUrlBounded` when a signed artifact/diff
/// body exceeds the caller's byte ceiling — either the advertised
/// `content-length` is over the limit (rejected before reading a byte) or the
/// streamed response crosses the limit mid-flight (the request is cancelled so
/// an unbounded body is never buffered on a phone).
///
/// Terminal for the caller: a too-large body will not shrink on retry.
class ArtifactTooLargeException implements Exception {
  /// Creates an [ArtifactTooLargeException].
  const ArtifactTooLargeException({required this.limit, this.advertised});

  /// The caller's byte ceiling that was crossed.
  final int limit;

  /// The advertised `content-length`, when the server sent one.
  final int? advertised;

  @override
  String toString() =>
      'ArtifactTooLargeException: body exceeds $limit bytes'
      '${advertised != null ? ' (advertised $advertised)' : ''}';
}
