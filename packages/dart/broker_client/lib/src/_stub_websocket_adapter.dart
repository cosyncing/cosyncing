import 'package:broker_client/src/websocket_adapter.dart';

/// Stub for web platform — throws on use.
///
/// Web WebSocket support requires a platform adapter.
/// This stub exists to satisfy the conditional import in
/// `websocket_adapter.dart`.
WebSocketAdapter createPlatformWebSocketAdapter(String url) =>
    throw UnsupportedError(
      'WebSocket connections are not supported on this platform. '
      'Use a platform-specific adapter.',
    );
