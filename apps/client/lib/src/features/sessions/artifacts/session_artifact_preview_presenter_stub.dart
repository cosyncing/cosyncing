import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_file_service.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_preview_result.dart';
import 'package:flutter/widgets.dart';

/// Whether this target can present an HTML artifact preview.
bool get isSessionArtifactPreviewAvailable => false;

/// Web-safe fallback for platforms without an artifact WebView backend.
Future<SessionArtifactPreviewPresentationResult> showSessionArtifactPreview(
  BuildContext context,
  SessionArtifactCachedFile artifact, {
  SessionArtifactUriLauncher? uriLauncher,
}) async {
  return const SessionArtifactPreviewPresentationResult.unsupported();
}
