import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_preview_result.dart';
import 'package:cosyncing_client/src/platform/artifacts/session_artifact_preview_presenter_io.dart';
import 'package:cosyncing_client/src/platform/artifacts/workspace_html_staging.dart';

export 'package:cosyncing_client/src/platform/artifacts/workspace_html_staging.dart';

/// Stages [html] locally and hands the copy to the platform browser.
///
/// Returns false when staging or the launch failed, so the caller can say so
/// rather than leaving the reader looking at a button that did nothing.
///
/// The launch goes through the artifact preview's own fallback, which means it
/// inherits that path's policy evaluation: the staged copy is passed as both
/// the launch candidate and the one allowed local file, so nothing but this
/// file can be reached through it.
Future<bool> openWorkspaceHtmlInBrowser({
  required String sessionKey,
  required String path,
  required String html,
  required int size,
  required bool truncated,
}) async {
  try {
    final file = await stageWorkspaceHtmlFile(
      sessionKey: sessionKey,
      workspacePath: path,
      html: html,
      size: size,
      truncated: truncated,
    );
    final uri = Uri.file(file.path);
    final result = await openDesktopPreviewFallbackInBrowser(
      launchCandidateUri: uri,
      allowedLocalFileUri: uri,
      uriLauncher: const SessionArtifactPlatformUriLauncher(),
    );
    return result.status ==
        SessionArtifactPreviewPresentationStatus.externalOpenFallback;
  } on Object {
    return false;
  }
}
