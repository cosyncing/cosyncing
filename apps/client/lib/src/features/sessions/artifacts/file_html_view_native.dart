import 'dart:async';
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
Widget buildPassiveHtmlView({
  required String html,
  VoidCallback? onError,
  Key? key,
}) => _PassiveHtmlView(key: key, html: html, onError: onError);

class _PassiveHtmlView extends StatefulWidget {
  const _PassiveHtmlView({required this.html, this.onError, super.key});

  final String html;
  final VoidCallback? onError;

  @override
  State<_PassiveHtmlView> createState() => _PassiveHtmlViewState();
}

class _PassiveHtmlViewState extends State<_PassiveHtmlView> {
  WebViewController? _controller;

  @override
  void initState() {
    super.initState();
    unawaited(_initialize());
  }

  Future<void> _initialize() async {
    try {
      final controller = WebViewController();
      await controller.setJavaScriptMode(JavaScriptMode.disabled);
      await controller.setBackgroundColor(const Color(0x00000000));
      await controller.setNavigationDelegate(
        NavigationDelegate(
          onWebResourceError: (error) {
            if (mounted && (error.isForMainFrame ?? true)) {
              widget.onError?.call();
            }
          },
        ),
      );
      await controller.loadHtmlString(widget.html);
      if (mounted) setState(() => _controller = controller);
    } on Object {
      if (mounted) widget.onError?.call();
    }
  }

  Future<void> _reload() async {
    try {
      await _controller?.loadHtmlString(widget.html);
    } on Object {
      if (mounted) widget.onError?.call();
    }
  }

  @override
  void didUpdateWidget(covariant _PassiveHtmlView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.html != widget.html) {
      unawaited(_reload());
    }
  }

  @override
  Widget build(BuildContext context) => _controller == null
      ? const SizedBox.expand()
      : WebViewWidget(controller: _controller!);
}
