import 'dart:js_interop';

@JS('performance.memory.usedJSHeapSize')
external JSNumber? get _usedJsHeapSize;

/// Chrome's non-standard used JavaScript heap sample, when available.
int? benchmarkMemoryBytes() {
  try {
    return _usedJsHeapSize?.toDartInt;
  } on Object {
    return null;
  }
}
