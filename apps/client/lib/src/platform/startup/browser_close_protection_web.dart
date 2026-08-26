import 'dart:js_interop';

@JS('cosyncingSetBrowserCloseProtection')
external JSFunction? get _setBrowserCloseProtection;

/// Enables the browser's standard leave-page confirmation while session tabs
/// are open in this window.
///
/// The listener itself lives in `web/index.html` so it is registered before
/// Flutter and remains available throughout startup. Alternative web hosts
/// may omit the hook; that degrades to no protection instead of failing boot.
void setBrowserCloseProtection({required bool enabled}) {
  try {
    _setBrowserCloseProtection?.callAsFunction(null, enabled.toJS);
  } on Object {
    // Browser policy or an alternative host page may refuse the bridge.
  }
}
