import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:flutter/foundation.dart';

/// High-level result class for artifact preview presentation.
enum SessionArtifactPreviewPresentationStatus {
  /// A local cached artifact preview opened in an app-controlled surface.
  opened,

  /// This platform has no preview backend.
  unsupported,

  /// The preview blocked a navigation outside the local cached file.
  blockedNavigation,

  /// The preview flow fell back to a deliberate external-browser action.
  externalOpenFallback,

  /// External-browser fallback launch failed.
  externalOpenFailed,
}

/// Navigation policy block reason for blocked preview URLs.
enum SessionArtifactPreviewNavigationBlockReason {
  /// The URI is malformed and cannot be parsed.
  malformed,

  /// The URI target is likely a popup/new-window-like navigation target.
  popupLike,

  /// The URI target looks like a direct download candidate.
  downloadLike,

  /// The URI is non-local and disallowed in app-controlled preview.
  externalScheme,

  /// The URI is a local file that does not match allowed preview boundaries.
  localFileDisallowed,
}

/// Outcome of external URI launch attempts from preview fallback actions.
@immutable
class SessionArtifactUriLaunchResult {
  /// Creates a [SessionArtifactUriLaunchResult].
  const SessionArtifactUriLaunchResult._({
    required this.launched,
    this.errorMessage,
  });

  /// The URI launch command was accepted.
  const SessionArtifactUriLaunchResult.accepted()
    : this._(launched: true, errorMessage: null);

  /// The URI launch command failed.
  const SessionArtifactUriLaunchResult.failed(String message)
    : this._(launched: false, errorMessage: message);

  /// Whether a browser process was started.
  final bool launched;

  /// Human-readable launch failure details.
  final String? errorMessage;

  /// Whether the URI launch failed.
  bool get failed => !launched;
}

/// Abstraction for launching an external URI from preview fallback.
abstract interface class SessionArtifactUriLauncher {
  /// Human-readable launcher identifier for diagnostics or testing.
  String get name;

  /// Launches a URI externally.
  Future<SessionArtifactUriLaunchResult> launchUri(Uri uri);
}

/// Result from attempting to present a cached artifact preview.
@immutable
class SessionArtifactPreviewPresentationResult {
  /// Creates a [SessionArtifactPreviewPresentationResult].
  SessionArtifactPreviewPresentationResult({
    required this.status,
    required this.message,
    this.uri,
    this.blockReason,
    String? technicalDetail,
  }) : technicalDetail = boundedTechnicalDetail(technicalDetail);

  /// Successful local preview result.
  const SessionArtifactPreviewPresentationResult.opened()
    : status = SessionArtifactPreviewPresentationStatus.opened,
      message = 'Preview opened',
      uri = null,
      blockReason = null,
      technicalDetail = null;

  /// Unsupported platform result.
  const SessionArtifactPreviewPresentationResult.unsupported()
    : status = SessionArtifactPreviewPresentationStatus.unsupported,
      message = 'Artifact preview is unavailable on this platform.',
      uri = null,
      blockReason = null,
      technicalDetail = null;

  /// Blocked navigation result.
  factory SessionArtifactPreviewPresentationResult.blockedNavigation(
    Uri uri, {
    String? reason,
    SessionArtifactPreviewNavigationBlockReason? blockReason,
  }) {
    final reasonLabel = _navigationBlockLabel(blockReason);
    final reasonDetails = reason == null ? '' : ' ($reason)';
    return SessionArtifactPreviewPresentationResult(
      status: SessionArtifactPreviewPresentationStatus.blockedNavigation,
      message:
          'Blocked external preview navigation$reasonLabel$reasonDetails: $uri',
      uri: uri,
      blockReason: blockReason,
    );
  }

  /// External-open fallback result.
  factory SessionArtifactPreviewPresentationResult.externalOpenFallback(
    Uri uri,
  ) {
    return SessionArtifactPreviewPresentationResult(
      status: SessionArtifactPreviewPresentationStatus.externalOpenFallback,
      message: 'Open in browser fallback requested: $uri',
      uri: uri,
    );
  }

  /// External-open fallback launch failed.
  factory SessionArtifactPreviewPresentationResult.externalOpenFailed(
    Uri uri, {
    String error = 'The browser launch failed.',
  }) {
    return SessionArtifactPreviewPresentationResult(
      status: SessionArtifactPreviewPresentationStatus.externalOpenFailed,
      message: "Couldn't open the preview in your browser. Try again.",
      uri: uri,
      technicalDetail: error,
    );
  }

  /// Preview presentation status.
  final SessionArtifactPreviewPresentationStatus status;

  /// Whether an app-controlled WebView preview was opened.
  bool get opened => status == SessionArtifactPreviewPresentationStatus.opened;

  /// Whether preview ended with user-visible success.
  bool get completed =>
      status == SessionArtifactPreviewPresentationStatus.opened ||
      status == SessionArtifactPreviewPresentationStatus.externalOpenFallback;

  /// User-facing status or error message.
  final String message;

  /// Related URI for blocked navigation or external fallback results.
  final Uri? uri;

  /// Optional classification for blocked navigation results.
  final SessionArtifactPreviewNavigationBlockReason? blockReason;

  /// Raw launcher failure retained for an explicit diagnostic disclosure.
  ///
  /// Never concatenate this into [message] or another primary UI surface.
  final String? technicalDetail;

  static String _navigationBlockLabel(
    SessionArtifactPreviewNavigationBlockReason? reason,
  ) {
    return switch (reason) {
      SessionArtifactPreviewNavigationBlockReason.malformed =>
        ' (malformed URL)',
      SessionArtifactPreviewNavigationBlockReason.popupLike =>
        ' (popup/new-window-like target)',
      SessionArtifactPreviewNavigationBlockReason.downloadLike =>
        ' (download-like target)',
      SessionArtifactPreviewNavigationBlockReason.externalScheme =>
        ' (external scheme)',
      SessionArtifactPreviewNavigationBlockReason.localFileDisallowed =>
        ' (local file disallowed)',
      null => '',
    };
  }
}

/// Navigation policy decision for preview WebViews.
@immutable
class SessionArtifactPreviewNavigationDecision {
  /// Creates a [SessionArtifactPreviewNavigationDecision].
  const SessionArtifactPreviewNavigationDecision._({
    required this.isAllowed,
    this.result,
  });

  /// Allows local-file navigation.
  const SessionArtifactPreviewNavigationDecision.allow()
    : this._(isAllowed: true);

  /// Blocks navigation and exposes a user-facing result.
  const SessionArtifactPreviewNavigationDecision.block(
    SessionArtifactPreviewPresentationResult result,
  ) : this._(isAllowed: false, result: result);

  /// Whether the navigation should be allowed.
  final bool isAllowed;

  /// Result to surface when navigation is blocked.
  final SessionArtifactPreviewPresentationResult? result;
}

/// Policy for artifact preview WebView navigation.
abstract final class SessionArtifactPreviewNavigationPolicy {
  /// Evaluates whether [url] can be loaded inside the preview surface.
  static SessionArtifactPreviewNavigationDecision evaluate({
    required String url,
    required Uri allowedLocalFileUri,
    bool allowSameDirectoryLocalAssets = false,
  }) {
    final uri = Uri.tryParse(url);
    if (uri == null) {
      final blockedUri = Uri(path: url);
      return SessionArtifactPreviewNavigationDecision.block(
        SessionArtifactPreviewPresentationResult.blockedNavigation(
          blockedUri,
          blockReason: SessionArtifactPreviewNavigationBlockReason.malformed,
        ),
      );
    }

    if (uri.scheme != 'file') {
      if (_isLikelyDownloadLikeUrl(uri)) {
        return SessionArtifactPreviewNavigationDecision.block(
          SessionArtifactPreviewPresentationResult.blockedNavigation(
            uri,
            blockReason:
                SessionArtifactPreviewNavigationBlockReason.downloadLike,
          ),
        );
      }

      final isPopupLike = _isLikelyPopupLikeUrl(uri);
      return SessionArtifactPreviewNavigationDecision.block(
        SessionArtifactPreviewPresentationResult.blockedNavigation(
          uri,
          blockReason: isPopupLike
              ? SessionArtifactPreviewNavigationBlockReason.popupLike
              : SessionArtifactPreviewNavigationBlockReason.externalScheme,
        ),
      );
    }

    if (!_isAllowedPreviewFileUri(
      candidateUri: uri,
      allowedUri: allowedLocalFileUri,
      allowSameDirectoryLocalAssets: allowSameDirectoryLocalAssets,
    )) {
      return SessionArtifactPreviewNavigationDecision.block(
        SessionArtifactPreviewPresentationResult.blockedNavigation(
          uri,
          blockReason:
              SessionArtifactPreviewNavigationBlockReason.localFileDisallowed,
        ),
      );
    }

    return const SessionArtifactPreviewNavigationDecision.allow();
  }

  static bool _isAllowedPreviewFileUri({
    required Uri candidateUri,
    required Uri allowedUri,
    required bool allowSameDirectoryLocalAssets,
  }) {
    if (candidateUri.host != allowedUri.host) {
      return false;
    }

    final candidatePath = _normalizedFilePath(candidateUri);
    final allowedPath = _normalizedFilePath(allowedUri);
    if (candidatePath == allowedPath) {
      return true;
    }

    if (!allowSameDirectoryLocalAssets) {
      return false;
    }

    return _sameDirectory(candidatePath, allowedPath);
  }

  static bool _isLikelyDownloadLikeUrl(Uri uri) {
    final path = uri.path.toLowerCase();
    if (path.isEmpty || !path.contains('.')) {
      return false;
    }

    return _downloadFileExtensions.any(path.endsWith);
  }

  static bool _isLikelyPopupLikeUrl(Uri uri) {
    final scheme = uri.scheme.toLowerCase();
    if (scheme.isEmpty && uri.path.toLowerCase() == 'about:blank') {
      return true;
    }

    return const {
      'about',
      'blob',
      'data',
      'intent',
      'javascript',
      'mailto',
      'itms-apps',
      'itms-services',
      'sms',
      'tel',
    }.contains(scheme);
  }

  static const _downloadFileExtensions = <String>[
    '.7z',
    '.apk',
    '.avif',
    '.bz2',
    '.csv',
    '.deb',
    '.doc',
    '.docx',
    '.dmg',
    '.exe',
    '.gz',
    '.iso',
    '.ipa',
    '.jpeg',
    '.jpg',
    '.pdf',
    '.png',
    '.ppt',
    '.pptx',
    '.rar',
    '.rpm',
    '.tar',
    '.tbz',
    '.tgz',
    '.tiff',
    '.xls',
    '.xlsx',
    '.zip',
    '.xz',
  ];

  static bool _sameDirectory(String leftPath, String rightPath) {
    final leftDir = _directoryPath(leftPath);
    final rightDir = _directoryPath(rightPath);
    if (leftDir == null || rightDir == null) {
      return false;
    }
    return leftDir == rightDir;
  }

  static String? _directoryPath(String path) {
    final lastSeparator = path.lastIndexOf('/');
    if (lastSeparator < 0) {
      return null;
    }
    return path.substring(0, lastSeparator);
  }

  static String _normalizedFilePath(Uri uri) {
    if (uri.path.isEmpty) {
      return '';
    }

    final path = uri.path.endsWith('/') && uri.path.length > 1
        ? uri.path.substring(0, uri.path.length - 1)
        : uri.path;
    return path;
  }
}
