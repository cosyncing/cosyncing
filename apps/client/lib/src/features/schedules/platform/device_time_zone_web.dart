import 'dart:js_interop';

/// Reads the browser's canonical IANA zone from `Intl`.
Future<String?> readDeviceIanaTimeZone() async {
  try {
    final value = _DateTimeFormat().resolvedOptions().timeZone?.toDart.trim();
    return value == null || value.isEmpty ? null : value;
  } on Object {
    return null;
  }
}

@JS('Intl.DateTimeFormat')
extension type _DateTimeFormat._(JSObject _) implements JSObject {
  external factory _DateTimeFormat();

  external _DateTimeFormatOptions resolvedOptions();
}

extension type _DateTimeFormatOptions._(JSObject _) implements JSObject {
  external JSString? get timeZone;
}
