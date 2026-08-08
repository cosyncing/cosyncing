import 'dart:async';
import 'dart:convert';

import 'package:broker_client/src/_io_websocket_adapter.dart'
    if (dart.library.html) 'package:broker_client/src/_stub_websocket_adapter.dart'
    as platform;

/// Abstract WebSocket adapter for testability.
///
/// The real implementation delegates to `dart:io` WebSocket.
/// Tests use [FakeWebSocketAdapter] which does not require a live broker.
///
/// The [messages] stream emits decoded JSON objects (Map or List).
/// It closes when the underlying WebSocket connection drops.
abstract class WebSocketAdapter {
  /// Creates a platform-appropriate [WebSocketAdapter] for [url].
  ///
  /// On desktop/mobile, delegates to `dart:io` WebSocket.
  /// On web, throws [UnsupportedError] until a web adapter is implemented.
  factory WebSocketAdapter(String url) =>
      platform.createPlatformWebSocketAdapter(url);

  /// Whether the underlying WebSocket is currently connected.
  bool get isConnected;

  /// Establishes the WebSocket connection.
  Future<void> connect();

  /// Sends a JSON-encodable object as a text frame.
  void sendJson(Object data) {
    send(jsonEncode(data));
  }

  /// Sends a raw string text frame.
  void send(String data);

  /// Stream of decoded JSON messages from the broker.
  ///
  /// Emits `Map<String, dynamic>` for object frames.
  /// Closes when the WebSocket connection drops or errors.
  Stream<Object?> get messages;

  /// Closes the WebSocket connection.
  Future<void> close();
}

/// A fake [WebSocketAdapter] for unit tests.
///
/// Does not require a live broker. Tests push messages via [simulateMessage]
/// and read sent frames via [sentFrames].
class FakeWebSocketAdapter implements WebSocketAdapter {
  /// Creates a [FakeWebSocketAdapter] for testing.
  FakeWebSocketAdapter();

  final _controller = StreamController<Object?>.broadcast();

  /// Frames sent via [send], captured for test assertions.
  final List<String> sentFrames = [];
  bool _connected = false;

  @override
  bool get isConnected => _connected;

  @override
  Future<void> connect() async {
    _connected = true;
  }

  @override
  void send(String data) {
    if (!_connected) {
      throw StateError('WebSocket not connected');
    }
    sentFrames.add(data);
  }

  @override
  void sendJson(Object data) {
    send(jsonEncode(data));
  }

  @override
  Stream<Object?> get messages => _controller.stream;

  /// Simulate receiving a decoded JSON message from the broker.
  void simulateMessage(Object? data) {
    _controller.add(data);
  }

  /// Simulate the WebSocket connection dropping.
  ///
  /// By default, closes the messages stream so listeners see
  /// `onDone`. Set [keepAlive] to true to keep the stream open
  /// for injecting late events (simulates race conditions where
  /// events arrive after the disconnect signal).
  void simulateDisconnect({bool keepAlive = false}) {
    _connected = false;
    if (!keepAlive && !_controller.isClosed) {
      _controller.close();
    }
  }

  @override
  Future<void> close() async {
    _connected = false;
    if (!_controller.isClosed) {
      await _controller.close();
    }
  }
}
