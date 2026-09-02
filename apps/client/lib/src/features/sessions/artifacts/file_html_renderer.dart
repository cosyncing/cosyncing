import 'package:cosyncing_client/src/features/sessions/artifacts/file_html_view.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_renderers.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_source_body.dart';
import 'package:flutter/widgets.dart';

/// Registry id of the HTML renderer.
const String htmlFileRendererId = 'html';

/// HTML, rendered in a frame that runs nothing — where a pane can hold one.
///
/// The only built-in whose shape differs by platform, and the difference is
/// deliberately in the *modes* rather than in an enabled flag: where no
/// embeddable view exists the Rendered toggle is absent, not greyed, so no
/// control suggests an affordance the platform cannot deliver.
FileRendererDescriptor htmlFileRenderer() => FileRendererDescriptor(
  id: htmlFileRendererId,
  source: const BuiltInRendererSource(),
  extensions: const {'html', 'htm', 'xhtml'},
  mimeTypes: const {'text/html', 'application/xhtml+xml'},
  // Source everywhere, on every platform: the bytes are what the reader asked
  // for, and a rendered page is the interpretation.
  modes: canRenderHtmlInPane
      ? const {FileViewMode.source, FileViewMode.rendered}
      : const {FileViewMode.source},
  granted: canRenderHtmlInPane
      ? const {FileRenderCapability.passiveFrame}
      : const {},
  prepare: _prepareHtml,
  build: _buildHtml,
);

FileRenderPreparation _prepareHtml(FileRenderRequest request) =>
    FileRenderPreparation(
      notice: canRenderHtmlInPane
          ? FileRenderNotice.passivePreview
          : FileRenderNotice.htmlSourceOnly,
    );

Widget _buildHtml(BuildContext context, FileRenderRequest request) {
  if (request.mode == FileViewMode.source || !canRenderHtmlInPane) {
    // Plain, not highlighted: an HTML file shown as source is markup the
    // reader wants to read literally, and the code renderer is the one that
    // owns highlighting.
    return FileSourceBody(
      lines: request.lines,
      surface: request.surface,
      tokens: request.tokens,
      anchorLine: request.anchorLine,
    );
  }
  return buildPassiveHtmlView(
    key: const Key('file-viewer-html'),
    html: request.content is TextFileContent
        ? (request.content as TextFileContent).text
        : '',
  );
}
