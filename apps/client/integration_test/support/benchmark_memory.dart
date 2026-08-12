export 'benchmark_memory_stub.dart'
    if (dart.library.io) 'benchmark_memory_io.dart'
    if (dart.library.js_interop) 'benchmark_memory_web.dart';
