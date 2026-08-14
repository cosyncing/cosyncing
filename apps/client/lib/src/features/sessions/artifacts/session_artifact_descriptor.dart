import 'package:broker_contract/broker_contract.dart';

/// Typed extraction of file-artifact metadata for UI affordance decisions.
class SessionArtifactDescriptor {
  /// Creates a [SessionArtifactDescriptor].
  const SessionArtifactDescriptor({
    required this.name,
    this.path,
    this.mimeType,
    this.deliveryClass = SessionArtifactDeliveryClass.interactive,
    this.size,
    this.artifactKey,
    this.contentHash,
    this.fetchUrl,
    this.url,
    this.format,
    this.redactionSummary,
    this.expiresAt,
    this.interactionPolicy,
  });

  /// Human-readable file name if known.
  final String? name;

  /// Broker-provided file path if known.
  final String? path;

  /// MIME type if known.
  final String? mimeType;

  /// Delivery class for the artifact payload.
  final SessionArtifactDeliveryClass deliveryClass;

  /// Artifact size in bytes when available.
  final int? size;

  /// Artifact key when available.
  final String? artifactKey;

  /// Content hash when available.
  final String? contentHash;

  /// Signed fetch URL when available.
  final String? fetchUrl;

  /// Legacy/direct artifact URL when available.
  ///
  /// Older broker messages may carry inline `data:` URLs here. New app clients
  /// should prefer signed [fetchUrl] references when present.
  final String? url;

  /// Export format metadata for artifact exports.
  final String? format;

  /// Optional redaction summary for download exports.
  final String? redactionSummary;

  /// Optional expiry epoch (ms) for short-retention export artifacts.
  final int? expiresAt;

  /// Broker-owned structured interaction policy.
  final ArtifactInteractionPolicy? interactionPolicy;

  /// Whether the broker supplied a supported signed interaction reference.
  bool get isInteractable => interactionPolicy?.canInteract ?? false;

  /// Inline data URL when the selected source is embedded in the message.
  String? get inlineDataUrl => isInlineDataUrl ? _downloadSource : null;

  /// Preferred download source URL.
  String? get _downloadSource =>
      (fetchUrl != null && fetchUrl!.isNotEmpty) ? fetchUrl : url;

  /// `true` when an action is available for download/fetch.
  bool get isDownloadable => _downloadSource != null;

  /// `true` when the preferred download source is inline `data:`.
  bool get isInlineDataUrl =>
      _downloadSource != null && _downloadSource!.startsWith('data:');

  /// Preferred download source URL for cache/export operations.
  String? get downloadSourceUrl => _downloadSource;

  /// Stable identity used for per-artifact UI action state.
  String get actionStateKey {
    if (artifactKey != null && artifactKey!.trim().isNotEmpty) {
      return artifactKey!.trim();
    }

    if (contentHash != null && contentHash!.trim().isNotEmpty) {
      return contentHash!.trim();
    }

    if (name != null && name!.trim().isNotEmpty) {
      return name!.trim();
    }

    if (path != null && path!.trim().isNotEmpty) {
      return path!.trim();
    }

    return 'artifact';
  }

  /// `true` when this artifact can be previewed as HTML.
  ///
  /// See `docs/architecture/client-ui.md` for the
  /// artifact capability-driven rendering contract and delivery-class gating.
  bool get isHtmlPreviewCandidate {
    if (deliveryClass != SessionArtifactDeliveryClass.interactive) {
      return false;
    }

    final mime = mimeType?.toLowerCase() ?? '';
    if (mime.contains('html')) {
      return true;
    }

    final source = path ?? name ?? fetchUrl ?? '';
    final lowercaseSource = source.toLowerCase();
    return lowercaseSource.endsWith('.html') ||
        lowercaseSource.endsWith('.htm');
  }

  /// Primary action label for available artifact download.
  String get downloadActionLabel =>
      isInlineDataUrl ? 'Fetch data URL' : 'Download';

  /// Human-readable display size.
  String get displaySize => size == null ? 'unknown' : '$size bytes';

  /// Builds a descriptor when [message] is a file artifact.
  static SessionArtifactDescriptor? fromMessage(AgentMessage message) {
    if (message.type != AgentMessageType.fileArtifact) {
      return null;
    }

    final name = _firstStringValue(message.raw, const [
      'name',
      'filename',
      'file',
    ]);
    final path = _firstStringValue(message.raw, const [
      'path',
      'filePath',
    ]);
    final mimeType = _firstStringValue(message.raw, const [
      'mimeType',
      'mediaType',
    ]);

    return SessionArtifactDescriptor(
      name: name,
      path: path,
      mimeType: mimeType,
      deliveryClass: _firstArtifactDeliveryClass(message.raw, const [
        'deliveryClass',
      ]),
      size: _firstIntValue(message.raw, const ['size']),
      artifactKey: _firstStringValue(message.raw, const ['artifactKey']),
      contentHash: _firstStringValue(message.raw, const ['contentHash']),
      fetchUrl: _firstStringValue(message.raw, const ['fetchUrl']),
      url: _firstStringValue(message.raw, const ['url']),
      format: _firstStringValue(message.raw, const ['format']),
      redactionSummary: _firstStringValue(message.raw, const [
        'redactionSummary',
      ]),
      expiresAt: _firstIntValue(message.raw, const ['expiresAt']),
      interactionPolicy: ArtifactInteractionPolicy.fromJson(
        message.raw['interactionPolicy'],
      ),
    );
  }
}

/// Delivery class values that indicate how the client should treat an artifact.
enum SessionArtifactDeliveryClass {
  /// Existing interactive artifacts intended for display paths.
  interactive,

  /// Export attachment intended to be download-only and non-previewable inline.
  exportAttachment,

  /// Unknown or unrecognized values from broker drift.
  unknown,
}

SessionArtifactDeliveryClass _firstArtifactDeliveryClass(
  Map<String, Object?> raw,
  List<String> keys,
) {
  final deliveryClass = _firstStringValue(raw, keys);
  if (deliveryClass == null) {
    return SessionArtifactDeliveryClass.interactive;
  }

  return switch (deliveryClass.trim()) {
    'interactive' => SessionArtifactDeliveryClass.interactive,
    'export-attachment' => SessionArtifactDeliveryClass.exportAttachment,
    _ => SessionArtifactDeliveryClass.unknown,
  };
}

String? _firstStringValue(Map<String, Object?> raw, List<String> keys) {
  for (final key in keys) {
    final value = raw[key];
    if (value is String && value.trim().isNotEmpty) {
      return value;
    }
    if (value != null && value is! Map && value is! Iterable) {
      final asString = value.toString();
      if (asString.trim().isNotEmpty) {
        return asString;
      }
    }
  }
  return null;
}

int? _firstIntValue(Map<String, Object?> raw, List<String> keys) {
  for (final key in keys) {
    final value = raw[key];
    if (value is int) {
      return value;
    }
    if (value is num) {
      return value.toInt();
    }
    if (value is String) {
      final parsed = int.tryParse(value);
      if (parsed != null) {
        return parsed;
      }
    }
  }
  return null;
}
