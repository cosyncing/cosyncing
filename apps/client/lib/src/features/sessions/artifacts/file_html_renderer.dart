import 'package:cosyncing_client/src/features/sessions/artifacts/file_html_view.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_renderers.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_source_body.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_preview_html_policy.dart';
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

/// [html] with the app's restrictive policy injected, ready for a frame.
///
/// Named and public because the frame itself is unreachable where the goldens
/// and the test suite run — `canRenderHtmlInPane` is false on Linux — so this
/// is the only place the guarantee can be asserted by a test that actually
/// runs. Both frame implementations receive the output of this and nothing
/// else.
String hardenHtmlForPassiveFrame(String html) =>
    SessionArtifactPreviewHtmlPolicy.injectRestrictiveContentSecurityPolicy(
      html,
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
  final text = request.content is TextFileContent
      ? (request.content as TextFileContent).text
      : '';
  return buildPassiveHtmlView(
    key: const Key('file-viewer-html'),
    // The sandbox and JavaScriptMode.disabled stop scripts, forms, navigation
    // and popups. They do not stop SUBRESOURCE loads: `<img src="https://…">`,
    // a stylesheet link, `@font-face`, `<video>` all still fetch. Rendering a
    // workspace file an agent wrote, in a repo the reader may not control,
    // would otherwise make their device request attacker-chosen URLs — with
    // their IP — the moment they tap Rendered.
    //
    // So the badge's "no network" half is this line, not the sandbox. Same
    // policy the artifact preview and this lane's own browser hand-off inject,
    // and the function is pure (`package:path` only), so it is web-safe.
    //
    // Two details worth knowing rather than rediscovering: `frame-ancestors`
    // in a meta tag is ignored by every browser (harmless, it is part of the
    // shared constant), and under the frame's opaque origin `'self'` matches
    // nothing — so only `data:` images and inline styles survive, which is
    // exactly the contract.
    html: hardenHtmlForPassiveFrame(text),
  );
}
