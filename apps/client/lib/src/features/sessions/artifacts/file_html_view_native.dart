import 'dart:io';

import 'package:flutter/widgets.dart';
import 'package:webview_flutter/webview_flutter.dart';

/// Whether this platform can composite an HTML view inside the pane.
///
/// Android, iOS and macOS can: `WebViewWidget` is an ordinary widget, so only
/// its host changes. Linux and Windows cannot, and this is not a "not yet":
/// `desktop_webview_window`'s only entry point creates a separate top-level OS
/// window, which by construction cannot be composited into a pane.
bool get canRenderHtmlInPane =>
    Platform.isAndroid || Platform.isIOS || Platform.isMacOS;

/// Shows [html] in a WebView with scripts disabled.
Widget buildPassiveHtmlView({required String html, Key? key}) =>
    _PassiveHtmlView(key: key, html: html);

class _PassiveHtmlView extends StatefulWidget {
  const _PassiveHtmlView({required this.html, super.key});

  final String html;

  @override
  State<_PassiveHtmlView> createState() => _PassiveHtmlViewState();
}

class _PassiveHtmlViewState extends State<_PassiveHtmlView> {
  late final WebViewController _controller = WebViewController()
    // The passive posture is not new here -- the artifact preview already
    // sets it. What is new is where the view lives.
    ..setJavaScriptMode(JavaScriptMode.disabled)
    ..setBackgroundColor(const Color(0x00000000))
    ..loadHtmlString(widget.html);

  @override
  void didUpdateWidget(covariant _PassiveHtmlView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.html != widget.html) {
      _controller.loadHtmlString(widget.html);
    }
  }

  @override
  Widget build(BuildContext context) => WebViewWidget(controller: _controller);
}
