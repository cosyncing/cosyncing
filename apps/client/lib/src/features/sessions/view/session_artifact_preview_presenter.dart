import 'package:cosyncing_client/src/features/sessions/data/session_artifact_file_service.dart';
import 'package:cosyncing_client/src/features/sessions/view/session_artifact_preview_presenter_stub.dart'
    if (dart.library.io) 'package:cosyncing_client/src/platform/artifacts/session_artifact_preview_presenter_io.dart'
    as platform;
import 'package:cosyncing_client/src/features/sessions/view/session_artifact_preview_result.dart';
import 'package:flutter/widgets.dart';

/// Whether this target can present an HTML artifact preview.
bool get isSessionArtifactPreviewAvailable {
  return platform.isSessionArtifactPreviewAvailable;
}

/// Presents a cached HTML artifact using the best available platform WebView.
Future<SessionArtifactPreviewPresentationResult> showSessionArtifactPreview(
  BuildContext context,
  SessionArtifactCachedFile artifact, {
  SessionArtifactUriLauncher? uriLauncher,
}) {
  return platform.showSessionArtifactPreview(
    context,
    artifact,
    uriLauncher: uriLauncher,
  );
}
