/// Web renders HTML inside the pane, so it never needs the hand-off.
///
/// Present only so the facade has one shape on every target.
Future<bool> openWorkspaceHtmlInBrowser({
  required String sessionKey,
  required String path,
  required String html,
  required int size,
  required bool truncated,
}) async => false;
