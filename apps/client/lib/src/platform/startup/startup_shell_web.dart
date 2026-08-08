import 'dart:js_interop';

/// The dismissal hook `web/index.html` installs on `window`.
///
/// Reads as `null` when the app is embedded in a page that does not provide the
/// shell (a test harness, an alternative host page), so the handshake degrades
/// to "nothing to dismiss" instead of throwing.
@JS('cosyncingStartupShellReady')
external JSFunction? get _startupShellReady;

/// Reports the first rendered app frame to the browser startup shell.
///
/// `web/index.html` paints a branded shell from the first HTML response and
/// removes it ONLY when this hook fires. The call site is a post-frame
/// callback, so by the time the shell is dismissed a frame containing real app
/// chrome has been rendered — loader completion, engine initialization and
/// `runApp()` are all reached long before anything is on screen and none of
/// them may dismiss the shell.
///
/// Never throws: the shell keeps its own bounded timeout, so a failed handshake
/// degrades to that path rather than taking the app down.
void notifyStartupShellFirstFrame() {
  try {
    _startupShellReady?.callAsFunction();
  } on Object {
    // Deliberately swallowed; see above.
  }
}
