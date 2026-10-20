import 'dart:js_interop';

import 'package:cosyncing_client/src/features/sessions/artifacts/html_document_lifetime.dart';
import 'package:flutter/widgets.dart';
import 'package:web/web.dart' as web;

/// Web composites an inline frame inside the pane.
bool get canRenderHtmlInPane => true;

/// [html] must be a host-owned sandbox wrapper, prepared once per revision.
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
  web.HTMLIFrameElement? _frame;
  late final JSFunction _visibilityChanged;

  @override
  void initState() {
    super.initState();
    _visibilityChanged = ((web.Event _) {
      // Destroy before another Flutter frame, including while the tab is
      // frozen.
      if (mounted) setState(replaceDocument);
    }).toJS;
    web.document.addEventListener('visibilitychange', _visibilityChanged);
  }

  @override
  void startDocument(int generation) {}

  @override
  void stopDocument() {
    final frame = _frame;
    _frame = null;
    if (frame == null) return;
    // Removes the wrapper and all of its execution contexts.
    frame
      ..onerror = null
      ..remove()
      ..srcdoc = ''.toJS;
  }

  @override
  void didUpdateWidget(covariant _HtmlView oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.html != widget.html) replaceDocument();
  }

  @override
  void dispose() {
    web.document.removeEventListener('visibilitychange', _visibilityChanged);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!documentActive || web.document.hidden) return const SizedBox.expand();
    final generation = documentGeneration;
    return HtmlElementView.fromTagName(
      key: ValueKey(generation),
      // Flutter owns this container; we own only its child iframe.
      tagName: 'div',
      onElementCreated: (element) {
        if (!isCurrentDocument(generation) || web.document.hidden) return;
        final container = element as web.HTMLElement;
        container.style.cssText = 'width:100%;height:100%';
        final frame = web.HTMLIFrameElement()
          ..setAttribute('sandbox', 'allow-scripts')
          ..setAttribute('referrerpolicy', 'no-referrer')
          ..setAttribute('title', 'HTML')
          ..style.cssText = 'border:none;width:100%;height:100%'
          ..onerror = ((web.Event _) {
            if (isCurrentDocument(generation)) {
              widget.onError?.call(
                isCurrent: () => isCurrentDocument(generation),
              );
            }
          }).toJS
          ..srcdoc = widget.html.toJS;
        _frame = frame;
        container.appendChild(frame);
      },
    );
  }
}
