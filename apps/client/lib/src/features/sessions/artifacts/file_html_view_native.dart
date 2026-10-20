import 'dart:async';
import 'dart:io';

import 'package:cosyncing_client/src/features/sessions/artifacts/html_document_lifetime.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:webview_flutter/webview_flutter.dart';

/// Linux and Windows retain Source and the explicit external-browser handoff.
bool get canRenderHtmlInPane => switch (debugDefaultTargetPlatformOverride ??
    (Platform.isAndroid
        ? TargetPlatform.android
        : Platform.isIOS
        ? TargetPlatform.iOS
        : Platform.isMacOS
        ? TargetPlatform.macOS
        : TargetPlatform.linux)) {
  TargetPlatform.android || TargetPlatform.iOS || TargetPlatform.macOS => true,
  _ => false,
};

/// [html] is a trusted wrapper with an opaque-origin sandboxed child. No file
/// URL, authenticated base URL or JavaScript channel is installed here.
Widget buildInteractiveHtmlView({
  required String html,
  void Function({bool Function()? isCurrent})? onError,
  Key? key,
}) => _HtmlView(key: key, html: html, onError: onError);

class _HtmlView extends StatefulWidget {
  const _HtmlView({required this.html, this.onError, super.key});
  final String html;
  final void Function({bool Function()? isCurrent})? onError;

  @override
  State<_HtmlView> createState() => _HtmlViewState();
}

class _HtmlViewState extends HtmlDocumentState<_HtmlView> {
  WebViewController? _controller;
  WebViewController? _initializing;

  @override
  void startDocument(int generation) => unawaited(_initialize(generation));

  Future<void> _initialize(int generation) async {
    WebViewController? controller;
    try {
      controller = WebViewController();
      _initializing = controller;
      await controller.setNavigationDelegate(
        NavigationDelegate(
          onNavigationRequest: (request) =>
              isCurrentDocument(generation) &&
                  (request.url == 'about:blank' ||
                      request.url == 'about:srcdoc')
              ? NavigationDecision.navigate
              : NavigationDecision.prevent,
          onWebResourceError: (error) {
            if (isCurrentDocument(generation) &&
                (error.isForMainFrame ?? false)) {
              widget.onError?.call(
                isCurrent: () => isCurrentDocument(generation),
              );
            }
          },
        ),
      );
      if (!isCurrentDocument(generation)) return;
      await controller.setJavaScriptMode(JavaScriptMode.unrestricted);
      if (!isCurrentDocument(generation)) return;
      await controller.loadHtmlString(widget.html);
      if (!isCurrentDocument(generation)) return;
      setState(() => _controller = controller);
    } on Object {
      if (isCurrentDocument(generation)) {
        widget.onError?.call(isCurrent: () => isCurrentDocument(generation));
      }
    } finally {
      if (identical(_initializing, controller)) _initializing = null;
      // A controller belongs to one generation only. Late setup/cleanup can
      // never load into, blank, or publish a replacement controller.
      if (controller != null && !identical(_controller, controller)) {
        await _unload(controller);
      }
    }
  }

  Future<void> _unload(WebViewController controller) async {
    try {
      // Executes only in our trusted outer document. Await removal of the
      // sandbox child before dropping the controller, rather than relying on
      // platform-widget detachment or stopLoading to stop artifact timers.
      await controller.runJavaScript(
        "document.querySelector('iframe')?.remove();",
      );
    } on Object {
      // Setup may not have reached a document yet. Blanking still follows.
    }
    try {
      await controller.setJavaScriptMode(JavaScriptMode.disabled);
      await controller.loadHtmlString('<!doctype html><title></title>');
    } on Object {
      // The platform may already have disposed its view.
    }
  }

  @override
  void stopDocument() {
    final controller = _controller ?? _initializing;
    _controller = null;
    _initializing = null;
    if (controller != null) unawaited(_unload(controller));
  }

  @override
  void didUpdateWidget(covariant _HtmlView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.html != widget.html) replaceDocument();
  }

  @override
  Widget build(BuildContext context) => _controller == null || !documentActive
      ? const SizedBox.expand()
      : WebViewWidget(
          key: ValueKey(documentGeneration),
          controller: _controller!,
        );
}
