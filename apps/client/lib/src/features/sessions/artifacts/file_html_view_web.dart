import 'dart:js_interop';

import 'package:flutter/widgets.dart';
import 'package:web/web.dart' as web;

/// Web composites an inline frame inside the pane, so nothing pops out.
bool get canRenderHtmlInPane => true;

/// Shows [html] in a frame the browser will not let run.
///
/// `HtmlElementView` composites the element inside Flutter's own canvas, so
/// the frame lives in the split pane, in the same page and the same tab. That
/// is the exact inverse of Linux and Windows, where the only available WebView
/// entry point opens a detached top-level OS window.
///
/// The bytes arrive through `srcdoc`, never as a `src` pointing at the file
/// route. Two reasons: the renderer contract stays identical on every platform
/// -- the host fetches, the renderer receives bytes -- and no broker
/// credential is ever inside the frame.
Widget buildPassiveHtmlView({required String html, Key? key}) =>
    HtmlElementView.fromTagName(
      key: key,
      tagName: 'iframe',
      onElementCreated: (element) {
        // An empty sandbox grants nothing. Omitting `allow-scripts` is the
        // browser-enforced equivalent of JavaScriptMode.disabled, and a
        // stronger guarantee than the native one because the browser enforces
        // it rather than a plugin setting. Omitting `allow-same-origin` puts
        // the frame in an opaque origin, so it cannot reach the app around it.
        (element as web.HTMLIFrameElement)
          ..setAttribute('sandbox', '')
          ..setAttribute('referrerpolicy', 'no-referrer')
          ..srcdoc = html.toJS
          // The frame fills the pane and draws no chrome of its own; the pane
          // already owns the border and the surface underneath it.
          ..style.cssText = 'border:none;width:100%;height:100%';
      },
    );
