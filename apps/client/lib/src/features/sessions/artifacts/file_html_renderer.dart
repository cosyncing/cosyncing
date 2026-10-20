import 'package:cosyncing_client/src/features/sessions/artifacts/file_html_view.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_renderers.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_source_body.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_preview_html_policy.dart';
import 'package:flutter/widgets.dart';

/// Registry id of the HTML renderer.
const String htmlFileRendererId = 'html';

/// Self-contained interactive HTML on platforms with an embedded browser.
FileRendererDescriptor htmlFileRenderer() => FileRendererDescriptor(
  id: htmlFileRendererId,
  source: const BuiltInRendererSource(),
  extensions: const {'html', 'htm', 'xhtml'},
  mimeTypes: const {'text/html', 'application/xhtml+xml'},
  modes: canRenderHtmlInPane
      ? const {FileViewMode.source, FileViewMode.rendered}
      : const {FileViewMode.source},
  granted: canRenderHtmlInPane
      ? const {FileRenderCapability.interactiveFrame}
      : const {},
  prepare: (request) => FileRenderPreparation(
    state:
        canRenderHtmlInPane &&
            !request.truncated &&
            request.content is TextFileContent
        ? prepareInteractiveHtmlDocument(
            (request.content as TextFileContent).text,
          )
        : null,
    notice: canRenderHtmlInPane ? null : FileRenderNotice.htmlSourceOnly,
  ),
  build: _buildHtml,
);

Widget _buildHtml(BuildContext context, FileRenderRequest request) {
  if (request.mode == FileViewMode.source ||
      !canRenderHtmlInPane ||
      request.truncated) {
    return FileSourceBody(
      lines: request.lines,
      surface: request.surface,
      tokens: request.tokens,
      anchorLine: request.anchorLine,
    );
  }
  return buildInteractiveHtmlView(
    key: ValueKey('file-viewer-html:${request.path}'),
    onError: request.onRenderFailed,
    html: request.prepared! as String,
  );
}
